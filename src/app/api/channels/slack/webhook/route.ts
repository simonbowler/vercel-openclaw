import { getPublicOrigin } from "@/server/public-url";
import { enqueueChannelJob } from "@/server/channels/driver";
import { channelDedupKey } from "@/server/channels/keys";
import { publishToChannelQueue } from "@/server/channels/queue";
import {
  getSlackUrlVerificationChallenge,
  isValidSlackSignature,
} from "@/server/channels/slack/adapter";
import { logInfo, logWarn } from "@/server/log";
import { getSandboxDomain } from "@/server/sandbox/lifecycle";
import { getInitializedMeta, getStore } from "@/server/store/store";

const FORWARD_TIMEOUT_MS = 10_000;
const SLACK_FORWARD_HEADERS = [
  "x-slack-signature",
  "x-slack-request-timestamp",
  "x-slack-retry-num",
  "x-slack-retry-reason",
] as const;

function unauthorizedResponse() {
  return Response.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
}

function extractSlackDedupId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const raw = payload as {
    event_id?: unknown;
    event?: { channel?: unknown; ts?: unknown };
  };
  if (typeof raw.event_id === "string" && raw.event_id.length > 0) {
    return raw.event_id;
  }

  if (
    typeof raw.event?.channel === "string" &&
    typeof raw.event?.ts === "string"
  ) {
    return `${raw.event.channel}:${raw.event.ts}`;
  }

  return null;
}

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text().catch(() => "");
  const signatureHeader = request.headers.get("x-slack-signature");
  const timestampHeader = request.headers.get("x-slack-request-timestamp");

  if (!signatureHeader || !timestampHeader) {
    return unauthorizedResponse();
  }

  const meta = await getInitializedMeta();
  const config = meta.channels.slack;
  if (!config) {
    return Response.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
  }

  const signatureValid = isValidSlackSignature({
    signingSecret: config.signingSecret,
    signatureHeader,
    timestampHeader,
    rawBody,
  });
  if (!signatureValid) {
    return unauthorizedResponse();
  }

  let payload: unknown;
  try {
    payload = rawBody.length > 0 ? JSON.parse(rawBody) : null;
  } catch {
    return Response.json({ ok: true });
  }

  const challenge = getSlackUrlVerificationChallenge(payload);
  if (challenge !== null) {
    return new Response(challenge, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }

  const dedupId = extractSlackDedupId(payload);
  if (dedupId) {
    const accepted = await getStore().acquireLock(channelDedupKey("slack", dedupId), 24 * 60 * 60);
    if (!accepted) {
      return Response.json({ ok: true });
    }
  }

  // --- Fast path: forward raw event to OpenClaw's native Slack HTTP handler ---
  // OpenClaw in HTTP mode handles Slack events, slash commands, and interactivity
  // natively on the main gateway port at /slack/events.  Forward the raw body
  // (not re-serialized) so OpenClaw can re-verify the Slack signature.
  if (meta.status === "running" && meta.sandboxId) {
    try {
      const sandboxUrl = await getSandboxDomain();
      const forwardUrl = `${sandboxUrl}/slack/events`;
      const forwardHeaders: Record<string, string> = {
        "content-type": request.headers.get("content-type") ?? "application/json",
      };
      for (const h of SLACK_FORWARD_HEADERS) {
        const v = request.headers.get(h);
        if (v) forwardHeaders[h] = v;
      }
      const resp = await fetch(forwardUrl, {
        method: "POST",
        headers: forwardHeaders,
        body: rawBody,
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      });
      if (resp.ok) {
        logInfo("channels.slack_fast_path_ok", { sandboxId: meta.sandboxId });
        // Proxy the response — Slack slash commands and interactivity expect
        // response bodies from the webhook endpoint.
        const respBody = await resp.text();
        return new Response(respBody, {
          status: resp.status,
          headers: { "content-type": resp.headers.get("content-type") ?? "application/json" },
        });
      }
      logWarn("channels.slack_fast_path_non_ok", {
        status: resp.status,
        sandboxId: meta.sandboxId,
      });
    } catch (error) {
      logWarn("channels.slack_fast_path_failed", {
        error: error instanceof Error ? error.message : String(error),
        sandboxId: meta.sandboxId,
      });
    }
    // Fall through to queue-based path
  }

  const job = {
    payload,
    receivedAt: Date.now(),
    origin: getPublicOrigin(request),
  };

  const { queued } = await publishToChannelQueue("slack", job);
  if (!queued) {
    await enqueueChannelJob("slack", job);
    logInfo("channels.slack_webhook_fallback_enqueue", { receivedAt: job.receivedAt });
  }

  return Response.json({ ok: true });
}
