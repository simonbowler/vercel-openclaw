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

test("CHANNEL_WEBHOOK_PATHS covers all three channels", () => {
  assert.equal(CHANNEL_WEBHOOK_PATHS.slack, "/api/channels/slack/webhook");
  assert.equal(CHANNEL_WEBHOOK_PATHS.telegram, "/api/channels/telegram/webhook");
  assert.equal(CHANNEL_WEBHOOK_PATHS.discord, "/api/channels/discord/webhook");
});

// ---------------------------------------------------------------------------
// Display URL: never includes bypass secret
// ---------------------------------------------------------------------------

test("buildChannelDisplayWebhookUrl returns clean URL for all channels", () => {
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass-secret";

  const request = makeRequest();

  for (const channel of ["slack", "telegram", "discord"] as const) {
    const url = buildChannelDisplayWebhookUrl(channel, request);
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
// Telegram: delivery URL stays on display path (no bypass)
// ---------------------------------------------------------------------------

test("buildChannelWebhookUrl for telegram returns display URL (no bypass)", () => {
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass-secret";

  const url = buildChannelWebhookUrl("telegram", makeRequest());
  assert.equal(url, "https://app.example.com/api/channels/telegram/webhook");
  assert.ok(!url.includes("x-vercel-protection-bypass"));
});

// ---------------------------------------------------------------------------
// Slack and Discord: delivery URL includes bypass when available
// ---------------------------------------------------------------------------

test("buildChannelWebhookUrl for slack includes bypass secret", () => {
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass-secret";

  const url = buildChannelWebhookUrl("slack", makeRequest());
  assert.ok(
    url.includes("x-vercel-protection-bypass=bypass-secret"),
    "slack delivery URL must include bypass secret",
  );
});

test("buildChannelWebhookUrl for discord includes bypass secret", () => {
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass-secret";

  const url = buildChannelWebhookUrl("discord", makeRequest());
  assert.ok(
    url.includes("x-vercel-protection-bypass=bypass-secret"),
    "discord delivery URL must include bypass secret",
  );
});

// ---------------------------------------------------------------------------
// Without bypass secret: all channels return clean URLs
// ---------------------------------------------------------------------------

test("buildChannelWebhookUrl without bypass returns clean URLs for all channels", () => {
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  const request = makeRequest();

  for (const channel of ["slack", "telegram", "discord"] as const) {
    const url = buildChannelWebhookUrl(channel, request);
    assert.ok(!url.includes("x-vercel-protection-bypass"));
    assert.ok(url.startsWith("https://app.example.com"));
  }
});
