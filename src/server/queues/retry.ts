export type QueueRetryMetadata = {
  messageId: string;
  deliveryCount: number;
};

export type QueueRetryDecision =
  | { acknowledge: true }
  | { afterSeconds: number };

export type QueueRetryOptions = {
  queueName: string;
  error: unknown;
  metadata: QueueRetryMetadata;
  isRetryable: (error: unknown) => boolean;
  logError: (event: string, data: Record<string, unknown>) => void;
  events?: { error: string; exhausted: string };
  maxDeliveryCount?: number;
  backoffBaseSeconds?: number;
  backoffMaxSeconds?: number;
};

const DEFAULT_MAX_DELIVERY_COUNT = 8;
const DEFAULT_BACKOFF_BASE_SECONDS = 5;
const DEFAULT_BACKOFF_MAX_SECONDS = 300;

/**
 * Extract a positive `retryAfterSeconds` hint from an error object, if present.
 */
function getRequestedRetryAfterSeconds(error: unknown): number | undefined {
  const value = (error as { retryAfterSeconds?: unknown })?.retryAfterSeconds;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.ceil(value)
    : undefined;
}

/**
 * Shared retry decision builder for Vercel Queue consumers.
 *
 * Returns `{ acknowledge: true }` for non-retryable errors or when
 * deliveryCount exceeds the max threshold. Otherwise returns
 * `{ afterSeconds }` using the greater of exponential backoff and the
 * error's `retryAfterSeconds` hint, capped at the max backoff.
 */
export function buildQueueRetryDecision(
  options: QueueRetryOptions,
): QueueRetryDecision {
  const maxDeliveryCount =
    options.maxDeliveryCount ?? DEFAULT_MAX_DELIVERY_COUNT;
  const backoffBaseSeconds =
    options.backoffBaseSeconds ?? DEFAULT_BACKOFF_BASE_SECONDS;
  const backoffMaxSeconds =
    options.backoffMaxSeconds ?? DEFAULT_BACKOFF_MAX_SECONDS;
  const events = options.events ?? {
    error: "queue.consumer_error",
    exhausted: "queue.consumer_exhausted",
  };

  const requested = getRequestedRetryAfterSeconds(options.error);

  options.logError(events.error, {
    queueName: options.queueName,
    messageId: options.metadata.messageId,
    deliveryCount: options.metadata.deliveryCount,
    retryable: options.isRetryable(options.error),
    error:
      options.error instanceof Error
        ? options.error.message
        : String(options.error),
    ...(requested !== undefined && { retryAfterSeconds: requested }),
  });

  if (!options.isRetryable(options.error)) {
    return { acknowledge: true };
  }

  if (options.metadata.deliveryCount > maxDeliveryCount) {
    options.logError(events.exhausted, {
      queueName: options.queueName,
      messageId: options.metadata.messageId,
      deliveryCount: options.metadata.deliveryCount,
    });
    return { acknowledge: true };
  }

  const exponential = Math.min(
    backoffMaxSeconds,
    2 ** options.metadata.deliveryCount * backoffBaseSeconds,
  );

  return {
    afterSeconds: Math.min(
      backoffMaxSeconds,
      Math.max(exponential, requested ?? 0),
    ),
  };
}
