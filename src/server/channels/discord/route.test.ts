/**
 * Route-level integration tests for the Discord webhook endpoint.
 *
 * Calls the actual POST handler from the Next.js route module with
 * fake infrastructure — no real network or sandbox calls.
 *
 * Run: npm test -- src/server/channels/discord/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createScenarioHarness } from "@/test-utils/harness";
import {
  patchNextServerAfter,
  getDiscordWebhookRoute,
  callRoute,
  pendingAfterCount,
  resetAfterCallbacks,
} from "@/test-utils/route-caller";
import {
  buildDiscordWebhook,
  buildDiscordPing,
  generateDiscordKeyPair,
} from "@/test-utils/webhook-builders";
import { channelQueueKey } from "@/server/channels/keys";

// ---------------------------------------------------------------------------
// Patch next/server before route modules are loaded
// ---------------------------------------------------------------------------
patchNextServerAfter();
const discordRoute = getDiscordWebhookRoute();

// ---------------------------------------------------------------------------
// Key pair for signing
// ---------------------------------------------------------------------------
const keys = generateDiscordKeyPair();

function configureDiscord(h: ReturnType<typeof createScenarioHarness>) {
  return h.mutateMeta((meta) => {
    meta.channels.discord = {
      publicKey: keys.publicKeyHex,
      applicationId: "app-test-123",
      botToken: "discord-bot-token-test",
      configuredAt: Date.now(),
    };
  });
}

// ===========================================================================
// Signature validation
// ===========================================================================

test("Discord route: missing signature headers returns 401", async () => {
  const h = createScenarioHarness();
  try {
    await configureDiscord(h);

    const request = new Request("http://localhost:3000/api/channels/discord/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "1", type: 1 }),
    });

    const result = await callRoute(discordRoute.POST, request);

    assert.equal(result.status, 401);
    const body = result.json as { error: string };
    assert.equal(body.error, "DISCORD_SIGNATURE_INVALID");
  } finally {
    resetAfterCallbacks();
    h.teardown();
  }
});

test("Discord route: invalid signature returns 401", async () => {
  const h = createScenarioHarness();
  try {
    await configureDiscord(h);

    const timestamp = String(Math.floor(Date.now() / 1000));
    const request = new Request("http://localhost:3000/api/channels/discord/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-ed25519": "0".repeat(128),
        "x-signature-timestamp": timestamp,
      },
      body: JSON.stringify({ id: "1", type: 2 }),
    });

    const result = await callRoute(discordRoute.POST, request);

    assert.equal(result.status, 401);
    const body = result.json as { error: string };
    assert.equal(body.error, "DISCORD_SIGNATURE_INVALID");
  } finally {
    resetAfterCallbacks();
    h.teardown();
  }
});

// ===========================================================================
// Channel not configured
// ===========================================================================

test("Discord route: returns 409 when discord is not configured", async () => {
  const h = createScenarioHarness();
  try {
    // Do NOT configure discord — leave it null
    const req = buildDiscordPing(keys);
    const result = await callRoute(discordRoute.POST, req);

    assert.equal(result.status, 409);
    const body = result.json as { error: string };
    assert.equal(body.error, "DISCORD_NOT_CONFIGURED");
  } finally {
    resetAfterCallbacks();
    h.teardown();
  }
});

// ===========================================================================
// PING interaction returns PONG (type 1)
// ===========================================================================

test("Discord route: PING interaction returns type 1 PONG", async () => {
  const h = createScenarioHarness();
  try {
    await configureDiscord(h);

    const req = buildDiscordPing(keys);
    const result = await callRoute(discordRoute.POST, req);

    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { type: 1 });

    // PING should NOT enqueue work
    assert.equal(pendingAfterCount(), 0);
  } finally {
    resetAfterCallbacks();
    h.teardown();
  }
});

// ===========================================================================
// Valid webhook enqueues work
// ===========================================================================

test("Discord route: valid signed command enqueues work and returns deferred response", async () => {
  const h = createScenarioHarness();
  try {
    await configureDiscord(h);

    const req = buildDiscordWebhook({
      privateKey: keys.privateKey,
      publicKeyHex: keys.publicKeyHex,
    });
    const result = await callRoute(discordRoute.POST, req);

    assert.equal(result.status, 200);
    // Discord deferred response is type 5
    assert.deepEqual(result.json, { type: 5 });

    // Verify a job was enqueued (via publishToChannelQueue fallback to store)
    const queueLen = await h.getStore().getQueueLength(channelQueueKey("discord"));
    assert.ok(queueLen >= 1, `Expected at least 1 queued job, got ${queueLen}`);
  } finally {
    resetAfterCallbacks();
    h.teardown();
  }
});

// ===========================================================================
// Dedup: same interaction id is not enqueued twice
// ===========================================================================

test("Discord route: duplicate interaction id is deduped", async () => {
  const h = createScenarioHarness();
  try {
    await configureDiscord(h);

    const payload = {
      id: "interaction-dedup-test",
      type: 2,
      token: "test-token",
      application_id: "app-test-123",
      channel_id: "ch-123",
      member: { user: { id: "user-123" } },
      data: { name: "ask", options: [{ name: "text", value: "hello dedup" }] },
    };

    // First request
    const req1 = buildDiscordWebhook({
      privateKey: keys.privateKey,
      publicKeyHex: keys.publicKeyHex,
      payload,
    });
    await callRoute(discordRoute.POST, req1);
    resetAfterCallbacks();

    const queueLenAfterFirst = await h.getStore().getQueueLength(channelQueueKey("discord"));

    // Second request with same interaction id
    const req2 = buildDiscordWebhook({
      privateKey: keys.privateKey,
      publicKeyHex: keys.publicKeyHex,
      payload,
    });
    const result2 = await callRoute(discordRoute.POST, req2);

    assert.equal(result2.status, 200);
    assert.deepEqual(result2.json, { type: 5 });

    const queueLenAfterSecond = await h.getStore().getQueueLength(channelQueueKey("discord"));
    assert.equal(
      queueLenAfterSecond,
      queueLenAfterFirst,
      "Queue length should not increase for duplicate interaction",
    );
  } finally {
    resetAfterCallbacks();
    h.teardown();
  }
});
