/**
 * Cron reconciler for the Telegram webhook.
 *
 * Runs every minute and calls setWebhook to keep the Telegram webhook
 * registered. This is critical because Telegram exponentially backs off
 * and stops delivering when it receives errors from the webhook URL
 * (e.g. during deployments, sandbox restarts, or OIDC token expiry).
 *
 * Re-registering the webhook tells Telegram to resume delivery.
 */

import { ApiError, jsonError, jsonOk } from "@/shared/http";
import { getCronSecret } from "@/server/env";
import { logError, logInfo } from "@/server/log";
import { getInitializedMeta } from "@/server/store/store";
import { setWebhook } from "@/server/channels/telegram/bot-api";
import { buildTelegramWebhookUrl } from "@/server/channels/state";

function isAuthorized(request: Request): boolean {
  const configured = getCronSecret();
  if (!configured) {
    return process.env.NODE_ENV !== "production";
  }

  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  const headerSecret = request.headers.get("x-cron-secret")?.trim() ?? "";

  return bearer === configured || headerSecret === configured;
}

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return jsonError(new ApiError(401, "UNAUTHORIZED", "Unauthorized"));
  }

  const meta = await getInitializedMeta();
  const config = meta.channels.telegram;
  if (!config) {
    return jsonOk({ ok: true, skipped: true, reason: "telegram_not_configured" });
  }

  try {
    const webhookUrl = buildTelegramWebhookUrl(request);
    await setWebhook(config.botToken, webhookUrl, config.webhookSecret);

    logInfo("cron.telegram_webhook_reconciled", {
      webhookUrl: webhookUrl.replace(/x-vercel-protection-bypass=[^&]+/, "x-vercel-protection-bypass=[redacted]"),
    });

    return jsonOk({ ok: true, webhookSet: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError("cron.telegram_webhook_reconcile_failed", { error: message });
    return jsonError(new ApiError(500, "TELEGRAM_WEBHOOK_FAILED", message));
  }
}
