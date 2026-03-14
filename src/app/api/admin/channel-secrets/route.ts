import { requireMutationAuth, authJsonOk } from "@/server/auth/route-auth";
import { ApiError, jsonError } from "@/shared/http";
import { getInitializedMeta } from "@/server/store/store";
import { signSlackPayload } from "@/server/smoke/remote-crypto";
import { logInfo, logWarn } from "@/server/log";

/**
 * Server-side smoke webhook sender.
 *
 * Accepts a channel name and payload body, signs it using the stored
 * channel secrets, and POSTs the signed webhook directly to the local
 * webhook endpoint. Raw secrets never leave the server — they are used
 * server-side only for signing/header construction.
 *
 * POST /api/admin/channel-secrets
 * Body: { channel: "slack" | "telegram", body: string }
 * Returns: { sent: boolean, status?: number, channel: string }
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  let input: { channel?: string; body?: string };
  try {
    input = await request.json();
  } catch {
    return jsonError(new ApiError(400, "INVALID_JSON", "Request body must be valid JSON."));
  }

  const { channel, body: payloadBody } = input;
  if (typeof channel !== "string" || typeof payloadBody !== "string") {
    return jsonError(new ApiError(400, "MISSING_FIELDS", "channel and body are required strings."));
  }

  try {
    const meta = await getInitializedMeta();
    const origin = new URL(request.url).origin;

    if (channel === "slack") {
      const config = meta.channels.slack;
      if (!config) {
        return authJsonOk({ configured: false, sent: false, channel }, auth);
      }
      const headers = signSlackPayload(config.signingSecret, payloadBody);
      const res = await fetch(`${origin}/api/channels/slack/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: payloadBody,
      });
      logInfo("admin.smoke_webhook_sent", { channel, status: res.status });
      return authJsonOk({ configured: true, sent: res.ok, status: res.status, channel }, auth);
    }

    if (channel === "telegram") {
      const config = meta.channels.telegram;
      if (!config) {
        return authJsonOk({ configured: false, sent: false, channel }, auth);
      }
      const res = await fetch(`${origin}/api/channels/telegram/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-telegram-bot-api-secret-token": config.webhookSecret,
        },
        body: payloadBody,
      });
      logInfo("admin.smoke_webhook_sent", { channel, status: res.status });
      return authJsonOk({ configured: true, sent: res.ok, status: res.status, channel }, auth);
    }

    return jsonError(new ApiError(400, "UNSUPPORTED_CHANNEL", "Only slack and telegram are supported."));
  } catch (error) {
    logWarn("admin.smoke_webhook_failed", {
      channel,
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonError(new ApiError(503, "SEND_FAILED", "Failed to send smoke webhook."));
  }
}
