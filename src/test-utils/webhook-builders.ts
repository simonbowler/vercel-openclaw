/**
 * Signed/secreted webhook request builders for Slack, Telegram, and Discord.
 *
 * Each builder produces a correctly authenticated Request object that
 * passes the corresponding adapter's signature verification.
 */

import * as crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

export type SlackWebhookOptions = {
  /** The signing secret configured in the Slack channel config. */
  signingSecret: string;
  /** The event payload. Defaults to a simple message event. */
  payload?: Record<string, unknown>;
  /** Override the timestamp (Unix seconds). */
  timestampSeconds?: number;
};

function defaultSlackPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "event_callback",
    event_id: `Ev${Date.now()}`,
    event: {
      type: "message",
      text: "hello from test",
      channel: "C1234567890",
      ts: `${Math.floor(Date.now() / 1000)}.000001`,
      user: "U1234567890",
    },
    ...overrides,
  };
}

/**
 * Build a correctly signed Slack webhook Request.
 */
export function buildSlackWebhook(options: SlackWebhookOptions): Request {
  const payload = options.payload ?? defaultSlackPayload();
  const rawBody = JSON.stringify(payload);
  const timestamp = options.timestampSeconds ?? Math.floor(Date.now() / 1000);
  const baseString = `v0:${timestamp}:${rawBody}`;
  const signature =
    "v0=" +
    crypto
      .createHmac("sha256", options.signingSecret)
      .update(baseString)
      .digest("hex");

  return new Request("http://localhost:3000/api/channels/slack/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-signature": signature,
      "x-slack-request-timestamp": String(timestamp),
    },
    body: rawBody,
  });
}

/**
 * Build a Slack URL verification challenge request (correctly signed).
 */
export function buildSlackUrlVerification(
  signingSecret: string,
  challenge = "test-challenge-token",
): Request {
  return buildSlackWebhook({
    signingSecret,
    payload: { type: "url_verification", challenge },
  });
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

export type TelegramWebhookOptions = {
  /** The webhook secret configured in the Telegram channel config. */
  webhookSecret: string;
  /** The update payload. Defaults to a simple text message. */
  payload?: Record<string, unknown>;
};

function defaultTelegramPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    update_id: Date.now(),
    message: {
      message_id: 1,
      from: { id: 12345, first_name: "Test", is_bot: false },
      chat: { id: 12345, type: "private", first_name: "Test" },
      date: Math.floor(Date.now() / 1000),
      text: "hello from test",
    },
    ...overrides,
  };
}

/**
 * Build a Telegram webhook Request with the correct secret header.
 */
export function buildTelegramWebhook(options: TelegramWebhookOptions): Request {
  const payload = options.payload ?? defaultTelegramPayload();
  return new Request("http://localhost:3000/api/channels/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": options.webhookSecret,
    },
    body: JSON.stringify(payload),
  });
}

// ---------------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------------

export type WhatsAppWebhookOptions = {
  appSecret: string;
  payload?: Record<string, unknown>;
};

function defaultWhatsAppPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-123",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "15550001111",
                phone_number_id: "123456789",
              },
              contacts: [
                {
                  profile: { name: "Test User" },
                  wa_id: "15551234567",
                },
              ],
              messages: [
                {
                  from: "15551234567",
                  id: "wamid.default",
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: "hello from whatsapp test" },
                },
              ],
            },
          },
        ],
      },
    ],
    ...overrides,
  };
}

export function buildWhatsAppWebhook(options: WhatsAppWebhookOptions): Request {
  const payload = options.payload ?? defaultWhatsAppPayload();
  const rawBody = JSON.stringify(payload);
  const signature =
    "sha256=" +
    crypto
      .createHmac("sha256", options.appSecret)
      .update(rawBody)
      .digest("hex");

  return new Request("http://localhost:3000/api/channels/whatsapp/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
    },
    body: rawBody,
  });
}

export function buildWhatsAppVerificationRequest(
  verifyToken: string,
  challenge = "whatsapp-test-challenge",
): Request {
  return new Request(
    `http://localhost:3000/api/channels/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=${encodeURIComponent(challenge)}`,
    {
      method: "GET",
    },
  );
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

export type DiscordWebhookOptions = {
  /** Ed25519 private key (for signing). */
  privateKey: crypto.KeyObject;
  /** Hex-encoded Ed25519 public key (32 bytes = 64 hex chars). */
  publicKeyHex: string;
  /** The interaction payload. Defaults to a simple application command. */
  payload?: Record<string, unknown>;
  /** Override the timestamp (Unix seconds). */
  timestampSeconds?: number;
};

export type DiscordKeyPair = {
  privateKey: crypto.KeyObject;
  publicKeyHex: string;
};

/**
 * Generate a fresh Ed25519 key pair for Discord webhook signing in tests.
 */
export function generateDiscordKeyPair(): DiscordKeyPair {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  // Export the raw 32-byte public key
  const spki = publicKey.export({ type: "spki", format: "der" });
  // SPKI for Ed25519 has a 12-byte prefix before the 32-byte key
  const rawPublicKey = spki.subarray(12);
  return {
    privateKey,
    publicKeyHex: rawPublicKey.toString("hex"),
  };
}

function defaultDiscordPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `interaction-${Date.now()}`,
    type: 2, // APPLICATION_COMMAND
    token: `test-interaction-token-${Date.now()}`,
    application_id: "app-123456",
    channel_id: "ch-123456",
    member: {
      user: { id: "user-123456" },
    },
    data: {
      name: "ask",
      options: [
        {
          name: "text",
          value: "hello from test",
        },
      ],
    },
    ...overrides,
  };
}

/**
 * Build a correctly signed Discord webhook Request.
 */
export function buildDiscordWebhook(options: DiscordWebhookOptions): Request {
  const payload = options.payload ?? defaultDiscordPayload();
  const rawBody = JSON.stringify(payload);
  const timestamp = String(
    options.timestampSeconds ?? Math.floor(Date.now() / 1000),
  );

  const message = Buffer.from(`${timestamp}${rawBody}`, "utf8");
  const signature = crypto
    .sign(null, message, options.privateKey)
    .toString("hex");

  return new Request("http://localhost:3000/api/channels/discord/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": signature,
      "x-signature-timestamp": timestamp,
    },
    body: rawBody,
  });
}

/**
 * Build a Discord PING interaction (type 1) request, correctly signed.
 */
export function buildDiscordPing(options: {
  privateKey: crypto.KeyObject;
  publicKeyHex: string;
}): Request {
  return buildDiscordWebhook({
    ...options,
    payload: { id: "ping-1", type: 1, token: "ping-token" },
  });
}
