import * as path from "node:path";
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
  ReplyBinarySource,
  ReplyMedia,
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
      const resolvedReply = await resolveSandboxMedia(reply, readyMeta.sandboxId);

      const replyText = toPlainText(resolvedReply);
      const imageCount = resolvedReply.images?.length ?? 0;
      const mediaCount = resolvedReply.media?.length ?? 0;

      logInfo("channels.gateway_response_received", withOperationContext(op, {
        channel: options.channel,
        replyTextLength: replyText.length,
        imageCount,
        mediaCount,
        imageKinds: resolvedReply.images?.map((img) => img.kind) ?? [],
        mediaTypes: resolvedReply.media?.map((m) => m.type) ?? [],
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
        mediaCount,
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
// 20 MB limit for general media (video, audio, documents).
// Telegram accepts up to 50 MB for most file types; Slack up to 1 GB.
// We use a conservative limit to keep serverless memory reasonable.
const MAX_SANDBOX_MEDIA_BYTES = 20 * 1024 * 1024;

export function isSandboxRelativePath(url: string): boolean {
  // Not an absolute URL (no protocol) and not a data URI
  return !url.includes("://") && !url.startsWith("data:");
}

/** Allow only safe characters in filenames to prevent shell injection. */
export function isSafeFilename(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name) && !name.startsWith(".");
}

/** Accept only normalized absolute paths under /workspace/. */
export function isSafeWorkspaceAbsolutePath(value: string): boolean {
  if (!value.startsWith("/workspace/")) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || !normalized.startsWith("/workspace/")) {
    return false;
  }

  const relativePath = normalized.slice("/workspace/".length);
  if (!relativePath) {
    return false;
  }

  return relativePath.split("/").every(isSafeFilename);
}

/**
 * Resolve an exact absolute sandbox path into a `kind: "data"` binary source.
 * Only accepts paths that pass `isSafeWorkspaceAbsolutePath`.
 */
export async function resolveExactSandboxPathFromSandbox(
  sandbox: { readFileToBuffer(opts: { path: string }): Promise<Buffer | null> },
  absolutePath: string,
): Promise<Extract<ReplyBinarySource, { kind: "data" }> | null> {
  if (!isSafeWorkspaceAbsolutePath(absolutePath)) {
    return null;
  }
  try {
    const buffer = await sandbox.readFileToBuffer({ path: absolutePath });
    if (!buffer || buffer.length === 0) {
      return null;
    }
    if (buffer.length > MAX_SANDBOX_MEDIA_BYTES) {
      logWarn("channels.sandbox_media_too_large", {
        path: absolutePath,
        sizeBytes: buffer.length,
        maxBytes: MAX_SANDBOX_MEDIA_BYTES,
      });
      return null;
    }
    const filename = path.posix.basename(absolutePath);
    const mimeType = inferMimeTypeFromFilename(filename);
    const base64 = buffer.toString("base64");
    logInfo("channels.sandbox_media_resolved", {
      filename,
      path: absolutePath,
      sizeBytes: buffer.length,
      mimeType,
    });
    return { kind: "data", mimeType, base64, filename };
  } catch (error) {
    logWarn("channels.sandbox_media_resolve_failed", {
      error: formatError(error),
      path: absolutePath,
      reason: "read_failed",
    });
    return null;
  }
}

/**
 * Unified resolver: bare filenames go through candidate-dir fan-out,
 * normalized `/workspace/*` paths resolve directly, everything else
 * is rejected.
 */
export async function resolveSandboxUrlSource(
  sandbox: { readFileToBuffer(opts: { path: string }): Promise<Buffer | null> },
  reference: string,
): Promise<Extract<ReplyBinarySource, { kind: "data" }> | null> {
  if (isSafeFilename(reference)) {
    return resolveFilenameFromSandbox(sandbox, reference);
  }
  if (isSafeWorkspaceAbsolutePath(reference)) {
    return resolveExactSandboxPathFromSandbox(sandbox, reference);
  }
  logWarn("channels.sandbox_media_unsafe_filename", { filename: reference });
  return null;
}

export function inferMimeTypeFromFilename(filename: string): string {
  const lower = filename.toLowerCase();
  // Images
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".bmp")) return "image/bmp";
  // Audio
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".aac")) return "audio/aac";
  if (lower.endsWith(".flac")) return "audio/flac";
  // Video
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mkv")) return "video/x-matroska";
  // Documents
  if (lower.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

/** Candidate sandbox directories to search for bare filenames. */
export const SANDBOX_CANDIDATE_DIRS = [
  SANDBOX_HOME_DIR,
  `${SANDBOX_HOME_DIR}/Desktop`,
  `${SANDBOX_HOME_DIR}/Downloads`,
  `${SANDBOX_HOME_DIR}/.openclaw`,
  `${SANDBOX_HOME_DIR}/.openclaw/generated/worker`,
  "/tmp",
];

/**
 * Try to resolve a bare filename from the sandbox filesystem into a
 * `kind: "data"` binary source.  Returns `null` when the file cannot
 * be found or is too large.
 */
export async function resolveFilenameFromSandbox(
  sandbox: { readFileToBuffer(opts: { path: string }): Promise<Buffer | null> },
  filename: string,
): Promise<Extract<ReplyBinarySource, { kind: "data" }> | null> {
  const candidatePaths = SANDBOX_CANDIDATE_DIRS.map(
    (dir) => `${dir}/${filename}`,
  );

  for (const path of candidatePaths) {
    try {
      const buffer = await sandbox.readFileToBuffer({ path });
      if (!buffer || buffer.length === 0) {
        continue;
      }
      if (buffer.length > MAX_SANDBOX_MEDIA_BYTES) {
        logWarn("channels.sandbox_media_too_large", {
          path,
          sizeBytes: buffer.length,
          maxBytes: MAX_SANDBOX_MEDIA_BYTES,
        });
        continue;
      }
      const mimeType = inferMimeTypeFromFilename(filename);
      const base64 = buffer.toString("base64");

      logInfo("channels.sandbox_media_resolved", {
        filename,
        path,
        sizeBytes: buffer.length,
        mimeType,
      });
      return { kind: "data", mimeType, base64, filename };
    } catch {
      continue;
    }
  }

  logWarn("channels.sandbox_media_not_found", { filename, candidatePaths });
  return null;
}

/**
 * Resolve sandbox-relative media references by downloading them from the
 * sandbox.  Handles both the legacy `images` array and the generic `media`
 * array.  HTTPS URLs and data URIs are left untouched.
 */
export async function resolveSandboxMedia(
  reply: ChannelReply,
  sandboxId: string | null,
): Promise<ChannelReply> {
  if (!sandboxId) return reply;

  // Collect all sandbox-relative references from both images and media.
  const hasRelativeImages = reply.images?.some(
    (img) => img.kind === "url" && isSandboxRelativePath(img.url),
  );
  const hasRelativeMedia = reply.media?.some(
    (m) => m.source.kind === "url" && isSandboxRelativePath(m.source.url),
  );

  if (!hasRelativeImages && !hasRelativeMedia) return reply;

  let sandbox;
  try {
    sandbox = await getSandboxController().get({ sandboxId });
  } catch (error) {
    logWarn("channels.sandbox_media_resolve_failed", {
      error: formatError(error),
      reason: "sandbox_unreachable",
    });
    return reply;
  }

  // --- Resolve legacy images ---
  let resolvedImages: NonNullable<ChannelReply["images"]> | undefined;
  if (reply.images && reply.images.length > 0) {
    const out: NonNullable<ChannelReply["images"]> = [];
    for (const image of reply.images) {
      if (image.kind !== "url" || !isSandboxRelativePath(image.url)) {
        out.push(image);
        continue;
      }
      const reference = image.url;
      const resolved = await resolveSandboxUrlSource(sandbox, reference);
      if (resolved) {
        out.push({ ...resolved, alt: image.alt });
      } else {
        out.push(image);
      }
    }
    resolvedImages = out.length > 0 ? out : undefined;
  }

  // --- Resolve generic media ---
  let resolvedMedia: ReplyMedia[] | undefined;
  if (reply.media && reply.media.length > 0) {
    const out: ReplyMedia[] = [];
    for (const entry of reply.media) {
      if (entry.source.kind !== "url" || !isSandboxRelativePath(entry.source.url)) {
        out.push(entry);
        continue;
      }
      const reference = entry.source.url;
      const resolved = await resolveSandboxUrlSource(sandbox, reference);
      if (resolved) {
        const source: ReplyBinarySource = { ...resolved, alt: entry.source.alt };
        out.push({ ...entry, source } as ReplyMedia);
      } else {
        out.push(entry);
      }
    }
    resolvedMedia = out.length > 0 ? out : undefined;
  }

  return {
    text: reply.text,
    images: resolvedImages ?? reply.images,
    media: resolvedMedia ?? reply.media,
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
