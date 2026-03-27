import * as workflowApi from "workflow/api";

import { hasWhatsAppBusinessCredentials } from "@/shared/channels";
import { getPublicOrigin } from "@/server/public-url";
import { channelDedupKey } from "@/server/channels/keys";
import { createWhatsAppAdapter, extractWhatsAppMessageId, isWhatsAppSignatureValid } from "@/server/channels/whatsapp/adapter";
import { sendMessage } from "@/server/channels/whatsapp/whatsapp-api";
import { drainChannelWorkflow } from "@/server/workflows/channels/drain-channel-workflow";
import { extractRequestId, logError, logInfo, logWarn } from "@/server/log";
import { createOperationContext, withOperationContext } from "@/server/observability/operation-context";
import { getSandboxDomain } from "@/server/sandbox/lifecycle";
import { getInitializedMeta, getStore } from "@/server/store/store";

const FORWARD_TIMEOUT_MS = 10_000;
const WHATSAPP_FORWARD_HEADERS = [
  "x-hub-signature-256",
  "content-type",
] as const;

type WhatsAppWebhookDedupLock = {
  key: string;
  token: string;
};

type WhatsAppWebhookDedupReleaseResult = {
  attempted: boolean;
  released: boolean;
  releaseError: string | null;
};

export const whatsappWebhookWorkflowRuntime = {
  start: workflowApi.start,
};

function unauthorizedResponse() {
  return Response.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
}

function workflowStartFailedResponse() {
  return Response.json(
    { ok: false, error: "WORKFLOW_START_FAILED", retryable: true },
    { status: 500 },
  );
}

async function releaseWhatsAppWebhookDedupLockForRetry(
  lock: WhatsAppWebhookDedupLock | null,
): Promise<WhatsAppWebhookDedupReleaseResult> {
  if (!lock) {
    return { attempted: false, released: false, releaseError: null };
  }

  try {
    await getStore().releaseLock(lock.key, lock.token);
    return { attempted: true, released: true, releaseError: null };
  } catch (error) {
    return {
      attempted: true,
      released: false,
      releaseError: error instanceof Error ? error.message : String(error),
    };
  }
}

function extractChallenge(url: URL): {
  mode: string | null;
  token: string | null;
  challenge: string | null;
} {
  return {
    mode: url.searchParams.get("hub.mode"),
    token: url.searchParams.get("hub.verify_token"),
    challenge: url.searchParams.get("hub.challenge"),
  };
}

export async function GET(request: Request): Promise<Response> {
  const meta = await getInitializedMeta();
  const config = meta.channels.whatsapp;
  if (!hasWhatsAppBusinessCredentials(config)) {
    return Response.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
  }

  const { mode, token, challenge } = extractChallenge(new URL(request.url));
  if (mode === "subscribe" && token === config.verifyToken && challenge) {
    return new Response(challenge, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }

  return unauthorizedResponse();
}

export async function POST(request: Request): Promise<Response> {
  const requestId = extractRequestId(request);
  const rawBody = await request.text().catch(() => "");
  const signatureHeader = request.headers.get("x-hub-signature-256");

  const meta = await getInitializedMeta();
  const config = meta.channels.whatsapp;
  if (!hasWhatsAppBusinessCredentials(config)) {
    return Response.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
  }

  if (!isWhatsAppSignatureValid(config.appSecret, rawBody, signatureHeader)) {
    logWarn("channels.whatsapp_webhook_rejected", {
      reason: "invalid_signature",
      requestId,
      hasSignature: Boolean(signatureHeader),
      bodyLength: rawBody.length,
    });
    return unauthorizedResponse();
  }

  let payload: unknown;
  try {
    payload = rawBody.length > 0 ? JSON.parse(rawBody) : null;
  } catch {
    logWarn("channels.whatsapp_webhook_rejected", {
      reason: "invalid_json",
      requestId,
      bodyLength: rawBody.length,
    });
    return Response.json({ ok: true });
  }

  try {
    const messageId = extractWhatsAppMessageId(payload);
    let dedupLock: WhatsAppWebhookDedupLock | null = null;
    if (messageId) {
      const dedupKey = channelDedupKey("whatsapp", messageId);
      const dedupToken = await getStore().acquireLock(dedupKey, 24 * 60 * 60);
      if (!dedupToken) {
        return Response.json({ ok: true });
      }
      dedupLock = { key: dedupKey, token: dedupToken };
    }

    const op = createOperationContext({
      trigger: "channel.whatsapp.webhook",
      reason: "incoming whatsapp webhook",
      requestId: requestId ?? null,
      channel: "whatsapp",
      dedupId: messageId ?? null,
      sandboxId: meta.sandboxId ?? null,
      snapshotId: meta.snapshotId ?? null,
      status: meta.status,
    });

    logInfo("channels.whatsapp_webhook_accepted", withOperationContext(op, {
      bodyLength: rawBody.length,
      hasMessageId: Boolean(messageId),
    }));

    if (meta.status === "running" && meta.sandboxId) {
      try {
        const sandboxUrl = await getSandboxDomain();
        const forwardHeaders: Record<string, string> = {};
        for (const headerName of WHATSAPP_FORWARD_HEADERS) {
          const headerValue = request.headers.get(headerName);
          if (headerValue) {
            forwardHeaders[headerName] = headerValue;
          }
        }

        const forwardResponse = await fetch(`${sandboxUrl}/whatsapp-webhook`, {
          method: "POST",
          headers: forwardHeaders,
          body: rawBody,
          signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
        });
        if (forwardResponse.ok) {
          logInfo("channels.whatsapp_fast_path_ok", withOperationContext(op, {
            sandboxId: meta.sandboxId,
          }));
          return Response.json({ ok: true });
        }

        logWarn("channels.whatsapp_fast_path_non_ok", withOperationContext(op, {
          sandboxId: meta.sandboxId,
          status: forwardResponse.status,
        }));
      } catch (error) {
        logWarn("channels.whatsapp_fast_path_failed", withOperationContext(op, {
          sandboxId: meta.sandboxId,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }

    let bootMessageId: string | null = null;
    if (meta.status !== "running") {
      try {
        const adapter = createWhatsAppAdapter(config);
        const extracted = await adapter.extractMessage(payload);
        if (extracted.kind === "message") {
          const result = await sendMessage(
            config.accessToken,
            extracted.message.phoneNumberId,
            extracted.message.from,
            "Starting up… I'll respond in a moment.",
          );
          bootMessageId = result.id;
          logInfo("channels.whatsapp_boot_message_sent", withOperationContext(op, {
            bootMessageId,
            to: extracted.message.from,
          }));
        }
      } catch (error) {
        logWarn("channels.whatsapp_boot_message_failed", withOperationContext(op, {
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }

    try {
      const origin = getPublicOrigin(request);
      await whatsappWebhookWorkflowRuntime.start(drainChannelWorkflow, [
        "whatsapp",
        payload,
        origin,
        requestId ?? null,
        bootMessageId,
      ]);
      logInfo("channels.whatsapp_workflow_started", withOperationContext(op));
    } catch (error) {
      const dedupRelease = await releaseWhatsAppWebhookDedupLockForRetry(dedupLock);
      logWarn("channels.whatsapp_workflow_start_failed", withOperationContext(op, {
        error: error instanceof Error ? error.message : String(error),
        attemptedAction: "start_drain_channel_workflow",
        dedupLockKey: dedupLock?.key ?? null,
        dedupLockReleaseAttempted: dedupRelease.attempted,
        dedupLockReleased: dedupRelease.released,
        dedupLockReleaseError: dedupRelease.releaseError,
        retryable: true,
      }));
      return workflowStartFailedResponse();
    }
  } catch (error) {
    logError("channels.whatsapp_webhook_enqueue_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return Response.json({ ok: true });
}
