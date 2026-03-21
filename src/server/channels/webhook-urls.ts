import type { ChannelName } from "@/shared/channels";
import { buildPublicDisplayUrl, buildPublicUrl } from "@/server/public-url";

/**
 * Canonical webhook path map for all channels.
 * This is the single source of truth — no other file should hardcode these paths.
 */
export const CHANNEL_WEBHOOK_PATHS: Record<ChannelName, string> = {
  slack: "/api/channels/slack/webhook",
  telegram: "/api/channels/telegram/webhook",
  discord: "/api/channels/discord/webhook",
};

/**
 * Build a display-safe webhook URL (no bypass secret) for admin-visible surfaces.
 */
export function buildChannelDisplayWebhookUrl(
  channel: ChannelName,
  request?: Request,
): string {
  return buildPublicDisplayUrl(CHANNEL_WEBHOOK_PATHS[channel], request);
}

/**
 * Build a webhook URL for platform registration and delivery.
 *
 * Telegram uses the display URL (no bypass query param) because Telegram
 * validates webhooks via the `x-telegram-bot-api-secret-token` header,
 * and including the bypass secret causes `setWebhook` to silently drop
 * the registration.
 *
 * Slack and Discord use `buildPublicUrl` which appends the bypass secret
 * when available.
 */
export function buildChannelWebhookUrl(
  channel: ChannelName,
  request?: Request,
): string {
  if (channel === "telegram") {
    return buildChannelDisplayWebhookUrl(channel, request);
  }

  return buildPublicUrl(CHANNEL_WEBHOOK_PATHS[channel], request);
}
