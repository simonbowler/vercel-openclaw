import { createHash } from "node:crypto";

import type { ChannelName } from "@/shared/channels";
import type { QueuedChannelJob } from "@/server/channels/driver";
import { logInfo, logWarn } from "@/server/log";
import { buildQueueRetryDecision } from "@/server/queues/retry";

/**
 * Topic names for Vercel Queue triggers. Must match vercel.json experimentalTriggers.
 */
const CHANNEL_TOPICS: Record<ChannelName, string> = {
  slack: "channel-slack",
  telegram: "channel-telegram",
  discord: "channel-discord",
};

/**
 * Resolve a deterministic idempotency key for a channel job.
 * Uses the explicit dedupId if present, otherwise SHA-256 of channel + payload.
 */
export function resolveIdempotencyKey<TPayload>(
  channel: ChannelName,
  job: QueuedChannelJob<TPayload>,
): string {
  const explicit = job.dedupId?.trim();
  if (explicit) {
    return `${channel}:${explicit}`;
  }

  try {
    return createHash("sha256")
      .update(channel)
      .update(":")
      .update(JSON.stringify(job.payload))
      .digest("hex");
  } catch {
    return createHash("sha256")
      .update(channel)
      .update(":")
      .update(String(job.receivedAt))
      .update(":")
      .update(job.origin)
      .digest("hex");
  }
}

/**
 * Publish a channel job to the Vercel Queue for the given channel.
 *
 * On Vercel, this uses the @vercel/queue SDK to durably enqueue the job.
 * Locally (when @vercel/queue send is unavailable or throws), falls back
 * to the existing store-based enqueue + drain path.
 */
export async function publishToChannelQueue<TPayload>(
  channel: ChannelName,
  job: QueuedChannelJob<TPayload>,
): Promise<{ queued: boolean; messageId: string | null }> {
  const topic = CHANNEL_TOPICS[channel];
  const idempotencyKey = resolveIdempotencyKey(channel, job);

  try {
    const { send } = await import("@vercel/queue");

    const result = await send(topic, job, {
      idempotencyKey,
    });

    logInfo("channels.queue_published", {
      channel,
      topic,
      messageId: result.messageId,
      idempotencyKey,
      receivedAt: job.receivedAt,
    });

    return { queued: true, messageId: result.messageId };
  } catch (error) {
    logWarn("channels.queue_publish_failed", {
      channel,
      topic,
      idempotencyKey,
      error: error instanceof Error ? error.message : String(error),
    });

    return { queued: false, messageId: null };
  }
}

/**
 * Return the Vercel Queue topic name for a channel.
 */
export function getChannelTopic(channel: ChannelName): string {
  return CHANNEL_TOPICS[channel];
}

// ---------------------------------------------------------------------------
// Queue consumer retry logic
// ---------------------------------------------------------------------------

type QueueConsumerRetryResult = { acknowledge: true } | { afterSeconds: number };
type QueueConsumerMetadata = { messageId: string; deliveryCount: number };

const QUEUE_MAX_DELIVERY_COUNT = 8;
const QUEUE_MAX_BACKOFF_SECONDS = 300;
const QUEUE_BACKOFF_BASE_SECONDS = 5;

/**
 * Channel-specific retry wrapper around the shared queue retry decision builder.
 *
 * Returns `{ acknowledge: true }` for non-retryable errors or when
 * deliveryCount exceeds the max threshold. Otherwise returns
 * `{ afterSeconds }` using the greater of exponential backoff and the
 * error's `retryAfterSeconds` hint, capped at `QUEUE_MAX_BACKOFF_SECONDS`.
 */
export function buildQueueConsumerRetry(
  channel: ChannelName,
  error: unknown,
  metadata: QueueConsumerMetadata,
  checkRetryable: (error: unknown) => boolean,
  logErrorFn: (event: string, data: Record<string, unknown>) => void,
): QueueConsumerRetryResult {
  return buildQueueRetryDecision({
    queueName: channel,
    error,
    metadata,
    isRetryable: checkRetryable,
    logError: logErrorFn,
    events: {
      error: "channels.queue_consumer_error",
      exhausted: "channels.queue_consumer_exhausted",
    },
    maxDeliveryCount: QUEUE_MAX_DELIVERY_COUNT,
    backoffBaseSeconds: QUEUE_BACKOFF_BASE_SECONDS,
    backoffMaxSeconds: QUEUE_MAX_BACKOFF_SECONDS,
  });
}
