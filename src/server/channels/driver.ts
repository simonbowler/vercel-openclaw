import type { ChannelName } from "@/shared/channels";
import type { OperationContext, SingleMeta } from "@/shared/types";
import {
  createOperationContext,
  withOperationContext,
} from "@/server/observability/operation-context";
import { extractReply, toPlainText } from "@/server/channels/core/reply";
import { startPlatformProcessingIndicator } from "@/server/channels/core/processing-indicator";
import { runWithBootMessages } from "@/server/channels/core/boot-messages";
import type {
  ChannelReply,
  ExtractedChannelMessage,
  GatewayMessage,
  PlatformAdapter,
} from "@/server/channels/core/types";
import { appendSessionHistory, readSessionHistory } from "@/server/channels/history";
import {
  callGatewayWithAuthRecovery,
} from "@/server/gateway/auth-recovery";
import { logInfo, logWarn } from "@/server/log";
import { getPublicOriginFromHint } from "@/server/public-url";
import { getSandboxController } from "@/server/sandbox/controller";
import type { TokenRefreshResult } from "@/server/sandbox/lifecycle";
import {
  ensureFreshGatewayToken,
  ensureSandboxReady,
  getSandboxDomain,
  reconcileSandboxHealth,
  touchRunningSandbox,
} from "@/server/sandbox/lifecycle";
import { getInitializedMeta } from "@/server/store/store";

const CHANNEL_PROCESSING_INDICATOR_DELAY_MS = 800;
export const DEFAULT_CHANNEL_SANDBOX_READY_TIMEOUT_MS = 25_000;
export const DEFAULT_CHANNEL_REQUEST_TIMEOUT_MS = 90_000;
const DEFAULT_CHANNEL_WAKE_RETRY_AFTER_SECONDS = 15;

export type QueuedChannelJob<TPayload = unknown> = {
  payload: TPayload;
  receivedAt: number;
  origin: string;
  retryCount?: number;
  nextAttemptAt?: number;
  lastError?: string;
  lastRetryAt?: number;
  dedupId?: string;
  /** Root operation ID for end-to-end correlation across webhook → queue → consumer → lifecycle. */
  opId?: string;
  /** Parent operation ID when this job was spawned from another correlated flow. */
  parentOpId?: string | null;
  /** Ingress request ID (x-vercel-id / x-request-id) for end-to-end correlation across async handoffs. */
  requestId?: string | null;
};

export type ChannelJobOptions<
  TConfig,
  TPayload,
  TMessage extends ExtractedChannelMessage,
> = {
  channel: ChannelName;
  getConfig(meta: SingleMeta): TConfig | null;
  createAdapter(config: TConfig): PlatformAdapter<TPayload, TMessage>;
  /** Override sandbox readiness timeout (ms). Defaults to DEFAULT_CHANNEL_SANDBOX_READY_TIMEOUT_MS. */
  sandboxReadyTimeoutMs?: number;
  /** Override gateway request timeout (ms). Defaults to DEFAULT_CHANNEL_REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number;
};

export async function runWithProcessingIndicator<
  TMessage extends ExtractedChannelMessage,
  TResult,
>(
  params: {
    channel: ChannelName;
    adapter: PlatformAdapter<unknown, TMessage>;
    message: TMessage;
    delayMs?: number;
    onError?: (error: unknown) => void;
  },
  run: () => Promise<TResult>,
): Promise<TResult> {
  const processingIndicator = await startPlatformProcessingIndicator(
    params.adapter,
    params.message,
    {
      delayMs: params.delayMs ?? CHANNEL_PROCESSING_INDICATOR_DELAY_MS,
      onError: params.onError ?? ((indicatorError) => {
        logWarn("channels.processing_indicator_failed", {
          channel: params.channel,
          error: formatError(indicatorError),
        });
      }),
    },
  );

  try {
    return await run();
  } finally {
    await processingIndicator.stop().catch(() => {});
  }
}

export async function processChannelJob<
  TConfig,
  TPayload,
  TMessage extends ExtractedChannelMessage,
>(
  options: ChannelJobOptions<TConfig, TPayload, TMessage>,
  job: QueuedChannelJob<TPayload>,
  externalOp?: OperationContext,
  existingBootHandle?: import("@/server/channels/core/types").BootMessageHandle,
): Promise<void> {
  // Build or adopt an operation context for end-to-end correlation.
  const op = externalOp ?? createOperationContext({
    trigger: "channel.queue.consumer",
    reason: `channel:${options.channel}`,
    channel: options.channel,
    requestId: job.requestId ?? null,
    retryCount: job.retryCount ?? null,
    parentOpId: job.parentOpId ?? null,
  });
  // Absorb job-level opId when present (propagated from webhook ingress).
  if (!externalOp && job.opId) {
    (op as { parentOpId: string | null }).parentOpId = job.opId;
  }

  const meta = await getInitializedMeta();
  const config = options.getConfig(meta);
  if (!config) {
    throw new Error(`${options.channel}_not_configured`);
  }

  const adapter = options.createAdapter(config);
  const extracted = await adapter.extractMessage(job.payload);
  if (extracted.kind === "skip") {
    logInfo("channels.job_skipped", withOperationContext(op, {
      channel: options.channel,
      reason: extracted.reason,
    }));
    return;
  }

  if (extracted.kind === "fail") {
    throw new Error(extracted.reason);
  }

  const message = extracted.message;
  const sessionKey = adapter.getSessionKey?.(message);
  if (sessionKey && (!message.history || message.history.length === 0)) {
    message.history = await readSessionHistory(options.channel, sessionKey);
  }

  const sandboxReadyTimeoutMs =
    options.sandboxReadyTimeoutMs ?? DEFAULT_CHANNEL_SANDBOX_READY_TIMEOUT_MS;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_CHANNEL_REQUEST_TIMEOUT_MS;

  // --- Phase 1: Wake the sandbox (with boot messages if supported) ---
  logInfo("channels.wake_requested", withOperationContext(op, {
    channel: options.channel,
    sandboxReadyTimeoutMs,
    sandboxId: meta.sandboxId,
    snapshotId: meta.snapshotId,
    status: meta.status,
  }));

  let readyMeta: SingleMeta;
  let gatewayUrl: string;
  let bootMessageSent = false;

  try {
    if (existingBootHandle || adapter.sendBootMessage) {
      const bootResult = await runWithBootMessages({
        channel: options.channel,
        adapter: adapter as PlatformAdapter<unknown, TMessage>,
        message,
        origin: resolveAppOrigin(job.origin),
        reason: `channel:${options.channel}`,
        timeoutMs: sandboxReadyTimeoutMs,
        existingBootHandle,
      });
      readyMeta = bootResult.meta;
      bootMessageSent = bootResult.bootMessageSent;

      if (readyMeta.status !== "running" || !readyMeta.sandboxId) {
        readyMeta = await ensureSandboxReady({
          origin: resolveAppOrigin(job.origin),
          reason: `channel:${options.channel}`,
          timeoutMs: sandboxReadyTimeoutMs,
          op,
        });
      }
    } else {
      readyMeta = await ensureSandboxReady({
        origin: resolveAppOrigin(job.origin),
        reason: `channel:${options.channel}`,
        timeoutMs: sandboxReadyTimeoutMs,
        op,
      });
    }
    gatewayUrl = await getSandboxDomain();
    logInfo("channels.wake_ready", withOperationContext(op, {
      channel: options.channel,
      bootMessageSent,
      sandboxId: readyMeta.sandboxId,
      status: readyMeta.status,
    }));
  } catch (sandboxError) {
    logWarn("channels.wake_retry_scheduled", withOperationContext(op, {
      channel: options.channel,
      error: formatError(sandboxError),
      retryAfterSeconds: DEFAULT_CHANNEL_WAKE_RETRY_AFTER_SECONDS,
    }));
    throw new RetryableChannelError(
      `sandbox_not_ready: ${formatError(sandboxError)}`,
      DEFAULT_CHANNEL_WAKE_RETRY_AFTER_SECONDS,
    );
  }
  await touchRunningSandbox();
  await ensureFreshGatewayToken();

  // --- Phase 2: Gateway request (with processing indicator) ---
  await runWithProcessingIndicator(
    {
      channel: options.channel,
      adapter: adapter as PlatformAdapter<unknown, TMessage>,
      message,
    },
    async () => {
      const messages = adapter.buildGatewayMessages
        ? await adapter.buildGatewayMessages(message)
        : defaultGatewayMessages(message);

      const hasImageParts = messages.some(
        (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"),
      );

      logInfo("channels.gateway_request_started", withOperationContext(op, {
        channel: options.channel,
        requestTimeoutMs,
        messageCount: messages.length,
        hasImageParts,
        sandboxId: readyMeta.sandboxId,
      }));

      const recoveryResult = await callGatewayWithAuthRecovery<ChannelReply>({
        label: `channel:${options.channel}`,
        sandboxId: readyMeta.sandboxId ?? "unknown",
        makeRequest: async () => {
          const currentMeta = await getInitializedMeta();
          return makeGatewayRequest({
            gatewayUrl,
            gatewayToken: currentMeta.gatewayToken,
            messages,
            sessionKey,
            requestTimeoutMs,
          });
        },
        parseResponse: async (response) => {
          return parseGatewayResponse(response);
        },
        onRefreshNeeded: async () => {
          try {
            const refreshResult = await ensureFreshGatewayToken({ force: true });
            return shouldRetryGatewayRequestAfterRefresh(refreshResult);
          } catch {
            return false;
          }
        },
      });

      if (!recoveryResult.ok) {
        if (recoveryResult.status === 410) {
          logWarn("channels.gateway_410_reconcile", withOperationContext(op, {
            channel: options.channel,
            sandboxId: readyMeta.sandboxId,
            error: recoveryResult.error,
          }));
          try {
            await reconcileSandboxHealth({
              origin: resolveAppOrigin(job.origin),
              reason: `channel:${options.channel}:gateway_410`,
              op,
            });
          } catch (reconcileError) {
            logWarn("channels.gateway_410_reconcile_failed", withOperationContext(op, {
              channel: options.channel,
              sandboxId: readyMeta.sandboxId,
              gatewayError: recoveryResult.error,
              attempted: "reconcileSandboxHealth",
              error: formatError(reconcileError),
            }));
          }
          throw new RetryableChannelError(
            "sandbox_gone_410: reconciliation scheduled",
            DEFAULT_CHANNEL_WAKE_RETRY_AFTER_SECONDS,
          );
        }
        if (recoveryResult.retryable) {
          throw new RetryableChannelError(
            recoveryResult.error,
            recoveryResult.retryAfterSeconds,
          );
        }
        throw new Error(recoveryResult.error);
      }

      const reply = recoveryResult.result;
      const resolvedReply = await resolveSandboxImages(reply, readyMeta.sandboxId);

      const replyText = toPlainText(resolvedReply);
      const imageCount = resolvedReply.images?.length ?? 0;

      logInfo("channels.gateway_response_received", withOperationContext(op, {
        channel: options.channel,
        replyTextLength: replyText.length,
        imageCount,
        imageKinds: resolvedReply.images?.map((img) => img.kind) ?? [],
        usingSendReplyRich: Boolean(adapter.sendReplyRich),
      }));

      if (adapter.sendReplyRich) {
        await adapter.sendReplyRich(message, resolvedReply);
      } else {
        await adapter.sendReply(message, replyText);
      }
      logInfo("channels.platform_reply_sent", withOperationContext(op, {
        channel: options.channel,
        imageCount,
      }));
      logInfo("channels.delivery_success", withOperationContext(op, {
        channel: options.channel,
      }));
      if (sessionKey) {
        await appendSessionHistory(options.channel, sessionKey, message.text, replyText);
      }
    },
  );
}

function defaultGatewayMessages(
  message: ExtractedChannelMessage,
): GatewayMessage[] {
  return [
    ...(message.history ?? []),
    { role: "user", content: message.text },
  ];
}

/**
 * Build and send the raw HTTP request to the gateway.
 * Returns the Response object directly -- auth recovery and parsing
 * are handled by the caller via `callGatewayWithAuthRecovery`.
 */
async function makeGatewayRequest(options: {
  gatewayUrl: string;
  gatewayToken: string;
  messages: GatewayMessage[];
  sessionKey?: string;
  requestTimeoutMs?: number;
}): Promise<Response> {
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_CHANNEL_REQUEST_TIMEOUT_MS;
  const url = new URL("/v1/chat/completions", options.gatewayUrl).toString();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${options.gatewayToken}`,
  };
  if (options.sessionKey) {
    headers["x-openclaw-session-key"] = options.sessionKey;
  }

  try {
    return await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "default",
        messages: options.messages,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      logWarn("channels.gateway_request_timeout", { timeoutMs });
    }
    throw toRetryableErrorIfNeeded(error);
  }
}

/**
 * Parse a successful gateway response into a ChannelReply.
 * Throws on empty body, invalid JSON, or missing reply content.
 */
async function parseGatewayResponse(response: Response): Promise<ChannelReply> {
  const body = await response.text();
  if (!body) {
    throw new RetryableChannelError("gateway_empty_response");
  }

  logInfo("channels.gateway_raw_response", {
    status: response.status,
    bodyLength: body.length,
  });

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    throw new Error(`gateway_invalid_json: ${formatError(error)}`);
  }

  const reply = extractReply(payload);
  if (!reply) {
    logWarn("channels.gateway_missing_reply", {
      bodyLength: body.length,
    });
    throw new Error("gateway_missing_reply");
  }

  return reply;
}

class RetryableChannelError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "RetryableChannelError";
  }
}

function shouldRetryGatewayRequestAfterRefresh(
  refreshResult: TokenRefreshResult,
): boolean {
  if (refreshResult.refreshed) {
    return true;
  }

  return refreshResult.reason.includes("no-refresh-needed") ||
    refreshResult.reason.includes("refreshed-by-another");
}

export function isRetryable(error: unknown): boolean {
  if (!error) {
    return false;
  }

  if (error instanceof RetryableChannelError) {
    return true;
  }

  if ((error as { name?: unknown }).name === "RetryableSendError") {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econn") ||
    message.includes("enotfound") ||
    message.includes("socket")
  );
}

function isTimeoutError(error: unknown): boolean {
  if (!error || !(error instanceof Error)) return false;
  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    error.message.toLowerCase().includes("timeout") ||
    error.message.toLowerCase().includes("timed out")
  );
}

function toRetryableErrorIfNeeded(error: unknown): Error {
  if (isRetryable(error)) {
    return new RetryableChannelError(formatError(error));
  }

  return error instanceof Error ? error : new Error(String(error));
}

const SANDBOX_HOME_DIR = "/home/vercel-sandbox";
// 5 MB limit: Telegram sendPhoto accepts max 10 MB uploads, base64 encoding
// adds ~33% overhead, and we want headroom for concurrent requests in serverless.
const MAX_SANDBOX_IMAGE_BYTES = 5 * 1024 * 1024;

function isSandboxRelativePath(url: string): boolean {
  // Not an absolute URL (no protocol) and not a data URI
  return !url.includes("://") && !url.startsWith("data:");
}

/** Allow only safe characters in filenames to prevent shell injection. */
function isSafeFilename(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name) && !name.startsWith(".");
}

function inferMimeTypeFromFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "image/png";
}

/**
 * Resolve sandbox-relative image paths by downloading them from the sandbox.
 * OpenClaw's MEDIA: lines emit bare filenames (e.g. "smiley-1.png") that exist
 * in the sandbox filesystem but are not publicly accessible URLs.
 */
async function resolveSandboxImages(
  reply: ChannelReply,
  sandboxId: string | null,
): Promise<ChannelReply> {
  if (!reply.images || reply.images.length === 0 || !sandboxId) {
    return reply;
  }

  const relativeImages = reply.images.filter(
    (img) => img.kind === "url" && isSandboxRelativePath(img.url),
  );
  if (relativeImages.length === 0) {
    return reply;
  }

  logInfo("channels.resolving_sandbox_images", {
    count: relativeImages.length,
    paths: relativeImages.map((img) => (img as { url: string }).url),
  });

  let sandbox;
  try {
    sandbox = await getSandboxController().get({ sandboxId });
  } catch (error) {
    logWarn("channels.sandbox_image_resolve_failed", {
      error: formatError(error),
      reason: "sandbox_unreachable",
    });
    return reply;
  }

  const resolvedImages: NonNullable<ChannelReply["images"]> = [];
  for (const image of reply.images) {
    if (image.kind !== "url" || !isSandboxRelativePath(image.url)) {
      resolvedImages.push(image);
      continue;
    }

    const filename = image.url;

    if (!isSafeFilename(filename)) {
      logWarn("channels.sandbox_image_unsafe_filename", { filename });
      resolvedImages.push(image);
      continue;
    }

    // Try common locations where OpenClaw saves generated files
    const candidatePaths = [
      `${SANDBOX_HOME_DIR}/${filename}`,
      `${SANDBOX_HOME_DIR}/Desktop/${filename}`,
      `${SANDBOX_HOME_DIR}/Downloads/${filename}`,
      `${SANDBOX_HOME_DIR}/.openclaw/${filename}`,
      `/tmp/${filename}`,
    ];

    let resolved = false;
    for (const path of candidatePaths) {
      try {
        const buffer = await sandbox.readFileToBuffer({ path });
        if (!buffer || buffer.length === 0) {
          continue;
        }
        if (buffer.length > MAX_SANDBOX_IMAGE_BYTES) {
          logWarn("channels.sandbox_image_too_large", {
            path,
            sizeBytes: buffer.length,
            maxBytes: MAX_SANDBOX_IMAGE_BYTES,
          });
          continue;
        }
        const mimeType = inferMimeTypeFromFilename(filename);
        const base64 = buffer.toString("base64");

        resolvedImages.push({
          kind: "data",
          mimeType,
          base64,
          filename,
          alt: image.alt,
        });

        logInfo("channels.sandbox_image_resolved", {
          filename,
          path,
          sizeBytes: buffer.length,
          mimeType,
        });
        resolved = true;
        break;
      } catch (error) {
        logWarn("channels.sandbox_image_read_error", {
          path,
          error: formatError(error),
        });
        continue;
      }
    }

    if (!resolved) {
      logWarn("channels.sandbox_image_not_found", { filename, candidatePaths });
      // Keep the original unresolved image (will fail on send but at least shows intent)
      resolvedImages.push(image);
    }
  }

  return {
    text: reply.text,
    images: resolvedImages.length > 0 ? resolvedImages : undefined,
  };
}

function resolveAppOrigin(origin: string | null | undefined): string {
  return getPublicOriginFromHint(origin);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
