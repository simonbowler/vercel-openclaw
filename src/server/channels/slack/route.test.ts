/**
 * Route-level integration tests for the Slack webhook endpoint.
 *
 * Calls the actual POST handler from the Next.js route module with
 * fake infrastructure — no real network or sandbox calls.
 *
 * Run: npm test -- src/server/channels/slack/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createScenarioHarness } from "@/test-utils/harness";
import {
  patchNextServerAfter,
  getSlackWebhookRoute,
  callRoute,
  pendingAfterCount,
  resetAfterCallbacks,
} from "@/test-utils/route-caller";
import {
  buildSlackWebhook,
  buildSlackUrlVerification,
} from "@/test-utils/webhook-builders";
import { channelQueueKey } from "@/server/channels/keys";

// ---------------------------------------------------------------------------
// Patch next/server before route modules are loaded
// ---------------------------------------------------------------------------
patchNextServerAfter();
const slackRoute = getSlackWebhookRoute();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SIGNING_SECRET = "test-slack-signing-secret";

function configureSlack(h: ReturnType<typeof createScenarioHarness>) {
  return h.mutateMeta((meta) => {
    meta.channels.slack = {
      signingSecret: SIGNING_SECRET,
      botToken: "xoxb-test-bot-token",
      configuredAt: Date.now(),
    };
  });
}

// ===========================================================================
// Signature validation
// ===========================================================================

test("Slack route: missing signature headers returns 401", async () => {
  const h = createScenarioHarness();
  try {
    await configureSlack(h);

    const request = new Request("http://localhost:3000/api/channels/slack/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "event_callback" }),
    });

    const result = await callRoute(slackRoute.POST, request);

    assert.equal(result.status, 401);
    assert.deepEqual(result.json, { ok: false, error: "UNAUTHORIZED" });
  } finally {
    resetAfterCallbacks();
    h.teardown();
  }
});

test("Slack route: invalid signature returns 401", async () => {
  const h = createScenarioHarness();
  try {
    await configureSlack(h);

    const timestamp = String(Math.floor(Date.now() / 1000));
    const request = new Request("http://localhost:3000/api/channels/slack/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-signature": "v0=deadbeefdeadbeefdeadbeefdeadbeef",
        "x-slack-request-timestamp": timestamp,
      },
      body: JSON.stringify({ type: "event_callback" }),
    });

    const result = await callRoute(slackRoute.POST, request);

    assert.equal(result.status, 401);
    assert.deepEqual(result.json, { ok: false, error: "UNAUTHORIZED" });
  } finally {
    resetAfterCallbacks();
    h.teardown();
  }
});

// ===========================================================================
// Channel not configured
// ===========================================================================

test("Slack route: returns 404 when slack is not configured", async () => {
  const h = createScenarioHarness();
  try {
    // Do NOT configure slack — leave it null
    const req = buildSlackWebhook({ signingSecret: SIGNING_SECRET });
    const result = await callRoute(slackRoute.POST, req);

    assert.equal(result.status, 404);
    assert.deepEqual(result.json, { ok: false, error: "NOT_FOUND" });
  } finally {
    resetAfterCallbacks();
    h.teardown();
  }
});

// ===========================================================================
// URL verification challenge
// ===========================================================================

test("Slack route: URL verification challenge returns the challenge token", async () => {
  const h = createScenarioHarness();
  try {
    await configureSlack(h);

    const req = buildSlackUrlVerification(SIGNING_SECRET, "my-challenge-token");
    const result = await callRoute(slackRoute.POST, req);

    assert.equal(result.status, 200);
    assert.equal(result.text, "my-challenge-token");
    assert.equal(
      result.response.headers.get("content-type"),
      "text/plain; charset=utf-8",
    );
    // URL verification should NOT enqueue work
    assert.equal(pendingAfterCount(), 0);
  } finally {
    resetAfterCallbacks();
    h.teardown();
  }
});

// ===========================================================================
// Valid webhook enqueues work
// ===========================================================================

test("Slack route: valid signed event enqueues work and returns 200", async () => {
  const h = createScenarioHarness();
  try {
    await configureSlack(h);

    const req = buildSlackWebhook({ signingSecret: SIGNING_SECRET });
    const result = await callRoute(slackRoute.POST, req);

    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { ok: true });

    // Verify a job was enqueued (via publishToChannelQueue fallback to store)
    const queueLen = await h.getStore().getQueueLength(channelQueueKey("slack"));
    assert.ok(queueLen >= 1, `Expected at least 1 queued job, got ${queueLen}`);
  } finally {
    resetAfterCallbacks();
    h.teardown();
  }
});

// ===========================================================================
// Dedup: same event_id is not enqueued twice
// ===========================================================================

test("Slack route: duplicate event_id is deduped (returns 200 but no second enqueue)", async () => {
  const h = createScenarioHarness();
  try {
    await configureSlack(h);

    const payload = {
      type: "event_callback",
      event_id: "Ev_DEDUP_TEST",
      event: {
        type: "message",
        text: "hello",
        channel: "C123",
        ts: "100.001",
        user: "U123",
      },
    };

    // First request
    const req1 = buildSlackWebhook({ signingSecret: SIGNING_SECRET, payload });
    await callRoute(slackRoute.POST, req1);
    resetAfterCallbacks();

    const queueLenAfterFirst = await h.getStore().getQueueLength(channelQueueKey("slack"));

    // Second request with same event_id
    const req2 = buildSlackWebhook({ signingSecret: SIGNING_SECRET, payload });
    const result2 = await callRoute(slackRoute.POST, req2);

    assert.equal(result2.status, 200);
    assert.deepEqual(result2.json, { ok: true });

    const queueLenAfterSecond = await h.getStore().getQueueLength(channelQueueKey("slack"));
    assert.equal(
      queueLenAfterSecond,
      queueLenAfterFirst,
      "Queue length should not increase for duplicate event",
    );
  } finally {
    resetAfterCallbacks();
    h.teardown();
  }
});
