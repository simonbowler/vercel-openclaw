import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  buildChannelDisplayWebhookUrl,
  buildChannelWebhookUrl,
  CHANNEL_WEBHOOK_PATHS,
} from "@/server/channels/webhook-urls";

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function makeRequest(origin = "https://app.example.com"): Request {
  const host = origin.replace(/^https?:\/\//, "");
  return new Request(`${origin}/admin`, {
    headers: {
      host,
      "x-forwarded-host": host,
      "x-forwarded-proto": origin.startsWith("https://") ? "https" : "http",
    },
  });
}

afterEach(() => {
  resetEnv();
});

// ---------------------------------------------------------------------------
// Path map completeness
// ---------------------------------------------------------------------------

test("CHANNEL_WEBHOOK_PATHS covers all app-owned webhook channels", () => {
  assert.equal(CHANNEL_WEBHOOK_PATHS.slack, "/api/channels/slack/webhook");
  assert.equal(CHANNEL_WEBHOOK_PATHS.telegram, "/api/channels/telegram/webhook");
  assert.equal(CHANNEL_WEBHOOK_PATHS.discord, "/api/channels/discord/webhook");
  assert.equal(CHANNEL_WEBHOOK_PATHS.whatsapp, "/api/channels/whatsapp/webhook");
});

// ---------------------------------------------------------------------------
// Display URL: never includes bypass secret
// ---------------------------------------------------------------------------

test("buildChannelDisplayWebhookUrl returns clean URL for webhook-proxied channels", () => {
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass-secret";

  const request = makeRequest();

  for (const channel of ["slack", "telegram", "discord", "whatsapp"] as const) {
    const url = buildChannelDisplayWebhookUrl(channel, request);
    assert.ok(url !== null, `${channel} display URL must not be null`);
    assert.ok(
      !url.includes("x-vercel-protection-bypass"),
      `${channel} display URL must not include bypass param`,
    );
    assert.ok(
      url.includes(CHANNEL_WEBHOOK_PATHS[channel]),
      `${channel} display URL must include correct path`,
    );
  }
});

// ---------------------------------------------------------------------------
// WhatsApp: display URL is clean, delivery URL includes bypass like Slack
// ---------------------------------------------------------------------------

test("buildChannelDisplayWebhookUrl returns clean URL for whatsapp", () => {
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  const url = buildChannelDisplayWebhookUrl("whatsapp", makeRequest());
  assert.equal(url, "https://app.example.com/api/channels/whatsapp/webhook");
});

test("buildChannelWebhookUrl for whatsapp includes bypass secret", () => {
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass-secret";
  const url = buildChannelWebhookUrl("whatsapp", makeRequest());
  assert.ok(url !== null, "whatsapp webhook URL must not be null");
  assert.ok(
    url.includes("x-vercel-protection-bypass=bypass-secret"),
    "whatsapp delivery URL must include bypass secret",
  );
});

// ---------------------------------------------------------------------------
// Telegram: delivery URL includes bypass like other channels
// ---------------------------------------------------------------------------

test("buildChannelWebhookUrl for telegram includes bypass secret", () => {
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass-secret";

  const url = buildChannelWebhookUrl("telegram", makeRequest());
  assert.ok(url !== null, "telegram webhook URL must not be null");
  assert.ok(
    url.includes("x-vercel-protection-bypass=bypass-secret"),
    "telegram delivery URL must include bypass secret",
  );
});

// ---------------------------------------------------------------------------
// Slack and Discord: delivery URL includes bypass when available
// ---------------------------------------------------------------------------

test("buildChannelWebhookUrl for slack includes bypass secret", () => {
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass-secret";

  const url = buildChannelWebhookUrl("slack", makeRequest());
  assert.ok(url !== null, "slack webhook URL must not be null");
  assert.ok(
    url.includes("x-vercel-protection-bypass=bypass-secret"),
    "slack delivery URL must include bypass secret",
  );
});

test("buildChannelWebhookUrl for discord includes bypass secret", () => {
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass-secret";

  const url = buildChannelWebhookUrl("discord", makeRequest());
  assert.ok(url !== null, "discord webhook URL must not be null");
  assert.ok(
    url.includes("x-vercel-protection-bypass=bypass-secret"),
    "discord delivery URL must include bypass secret",
  );
});

// ---------------------------------------------------------------------------
// Without bypass secret: all webhook-proxied channels return clean URLs
// ---------------------------------------------------------------------------

test("buildChannelWebhookUrl without bypass returns clean URLs for webhook-proxied channels", () => {
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  const request = makeRequest();

  for (const channel of ["slack", "telegram", "discord", "whatsapp"] as const) {
    const url = buildChannelWebhookUrl(channel, request);
    assert.ok(url !== null, `${channel} webhook URL must not be null`);
    assert.ok(!url.includes("x-vercel-protection-bypass"));
    assert.ok(url.startsWith("https://app.example.com"));
  }
});
