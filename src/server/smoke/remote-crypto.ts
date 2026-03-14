/**
 * Pure Node.js crypto helpers for signing channel webhooks in the remote smoke runner.
 * No dependency on test-utils — these are standalone functions.
 */

import { createHmac } from "node:crypto";

/**
 * Sign a Slack webhook payload using HMAC-SHA256.
 * Returns the headers needed for a valid Slack webhook request.
 */
export function signSlackPayload(
  signingSecret: string,
  rawBody: string,
): { "x-slack-signature": string; "x-slack-request-timestamp": string } {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const baseString = `v0:${timestamp}:${rawBody}`;
  const digest = createHmac("sha256", signingSecret)
    .update(baseString)
    .digest("hex");
  return {
    "x-slack-signature": `v0=${digest}`,
    "x-slack-request-timestamp": timestamp,
  };
}

/**
 * Build a minimal Slack app_mention webhook payload.
 */
export function buildSlackSmokePayload(): { body: string; dedupTs: string } {
  const ts = `${Math.floor(Date.now() / 1000)}.${Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, "0")}`;
  const payload = {
    type: "event_callback",
    event: {
      type: "app_mention",
      text: "smoke-test: reply with exactly smoke-ok",
      channel: "C_SMOKE_TEST",
      ts,
      user: "U_SMOKE",
    },
  };
  return { body: JSON.stringify(payload), dedupTs: ts };
}

/**
 * Build a minimal Telegram message webhook payload.
 */
export function buildTelegramSmokePayload(): string {
  const updateId = Math.floor(Math.random() * 1_000_000_000);
  const payload = {
    update_id: updateId,
    message: {
      message_id: updateId,
      text: "/ask smoke-test: reply with exactly smoke-ok",
      chat: { id: 999_999_999, type: "private" },
      from: { id: 999_999_998, is_bot: false, first_name: "SmokeTest" },
      date: Math.floor(Date.now() / 1000),
    },
  };
  return JSON.stringify(payload);
}
