/**
 * Tests for src/server/channels/queue.ts.
 *
 * Covers: getChannelTopic mapping, publishToChannelQueue graceful fallback
 * when @vercel/queue is unavailable, and idempotency key generation.
 *
 * Run: npm test src/server/channels/queue.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { QueuedChannelJob } from "@/server/channels/driver";
import {
  buildQueueConsumerRetry,
  getChannelTopic,
  publishToChannelQueue,
  resolveIdempotencyKey,
} from "@/server/channels/queue";
import type { ChannelName } from "@/shared/channels";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createJob(
  overrides: Partial<QueuedChannelJob<{ text: string }>> = {},
): QueuedChannelJob<{ text: string }> {
  return {
    payload: { text: "hello" },
    receivedAt: 1,
    origin: "https://app.test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getChannelTopic
// ---------------------------------------------------------------------------

test("getChannelTopic returns correct topic for each channel", () => {
  assert.equal(getChannelTopic("slack"), "channel-slack");
  assert.equal(getChannelTopic("telegram"), "channel-telegram");
  assert.equal(getChannelTopic("discord"), "channel-discord");
});

// ---------------------------------------------------------------------------
// resolveIdempotencyKey
// ---------------------------------------------------------------------------

test("resolveIdempotencyKey uses explicit dedupId prefixed with channel", () => {
  const job = createJob({ dedupId: "explicit-key-123" });
  const key = resolveIdempotencyKey("slack", job);
  assert.equal(key, "slack:explicit-key-123");
});

test("resolveIdempotencyKey trims whitespace from dedupId", () => {
  const job = createJob({ dedupId: "  spaced-key  " });
  const key = resolveIdempotencyKey("telegram", job);
  assert.equal(key, "telegram:spaced-key");
});

test("resolveIdempotencyKey uses SHA-256 hash when no dedupId", () => {
  const job = createJob(); // no dedupId
  const key = resolveIdempotencyKey("discord", job);

  const expected = createHash("sha256")
    .update("discord")
    .update(":")
    .update(JSON.stringify(job.payload))
    .digest("hex");
  assert.equal(key, expected);
});

test("resolveIdempotencyKey is deterministic for same payload", () => {
  const job1 = createJob({ payload: { text: "same" } });
  const job2 = createJob({ payload: { text: "same" }, receivedAt: 999 });

  const key1 = resolveIdempotencyKey("slack", job1);
  const key2 = resolveIdempotencyKey("slack", job2);
  assert.equal(key1, key2, "Same payload should produce same idempotency key");
});

test("resolveIdempotencyKey differs for different payloads", () => {
  const job1 = createJob({ payload: { text: "hello" } });
  const job2 = createJob({ payload: { text: "world" } });

  const key1 = resolveIdempotencyKey("slack", job1);
  const key2 = resolveIdempotencyKey("slack", job2);
  assert.notEqual(key1, key2, "Different payloads should produce different keys");
});

test("resolveIdempotencyKey differs across channels for same payload", () => {
  const job = createJob();

  const keySlack = resolveIdempotencyKey("slack", job);
  const keyTelegram = resolveIdempotencyKey("telegram", job);
  const keyDiscord = resolveIdempotencyKey("discord", job);

  assert.notEqual(keySlack, keyTelegram);
  assert.notEqual(keySlack, keyDiscord);
  assert.notEqual(keyTelegram, keyDiscord);
});

test("resolveIdempotencyKey ignores empty/whitespace dedupId", () => {
  const job = createJob({ dedupId: "   " });
  const key = resolveIdempotencyKey("slack", job);

  // Should fall back to SHA-256 hash (not "slack:   ")
  const expectedHash = createHash("sha256")
    .update("slack")
    .update(":")
    .update(JSON.stringify(job.payload))
    .digest("hex");
  assert.equal(key, expectedHash);
});

// ---------------------------------------------------------------------------
// publishToChannelQueue: graceful fallback
// ---------------------------------------------------------------------------

test("publishToChannelQueue returns queued=false when not on Vercel", async () => {
  // Without VERCEL_DEPLOYMENT_ID, @vercel/queue's send() will throw.
  // publishToChannelQueue should catch and return graceful fallback.
  const job = createJob();
  const result = await publishToChannelQueue("slack", job);

  assert.equal(result.queued, false);
  assert.equal(result.messageId, null);
});

test("publishToChannelQueue fallback works for each channel", async () => {
  const channels: ChannelName[] = ["slack", "telegram", "discord"];

  for (const channel of channels) {
    const job = createJob({ dedupId: `test-${channel}` });
    const result = await publishToChannelQueue(channel, job);

    assert.equal(result.queued, false, `${channel} should fallback gracefully`);
    assert.equal(result.messageId, null, `${channel} messageId should be null`);
  }
});

// ---------------------------------------------------------------------------
// buildQueueConsumerRetry
// ---------------------------------------------------------------------------

const alwaysRetryable = () => true;
const neverRetryable = () => false;
const noop = () => {};

test("buildQueueConsumerRetry acknowledges non-retryable errors", () => {
  const result = buildQueueConsumerRetry(
    "slack",
    new Error("permanent"),
    { messageId: "m1", deliveryCount: 1 },
    neverRetryable,
    noop,
  );
  assert.deepStrictEqual(result, { acknowledge: true });
});

test("buildQueueConsumerRetry acknowledges when deliveryCount exceeds max", () => {
  const result = buildQueueConsumerRetry(
    "slack",
    new Error("retryable"),
    { messageId: "m1", deliveryCount: 9 },
    alwaysRetryable,
    noop,
  );
  assert.deepStrictEqual(result, { acknowledge: true });
});

test("buildQueueConsumerRetry uses exponential backoff without retryAfterSeconds", () => {
  const result = buildQueueConsumerRetry(
    "telegram",
    new Error("retryable"),
    { messageId: "m1", deliveryCount: 1 },
    alwaysRetryable,
    noop,
  );
  // 2^1 * 5 = 10
  assert.deepStrictEqual(result, { afterSeconds: 10 });
});

test("buildQueueConsumerRetry honors retryAfterSeconds when larger than exponential", () => {
  const error = Object.assign(new Error("sandbox_not_ready"), {
    retryAfterSeconds: 15,
  });
  const result = buildQueueConsumerRetry(
    "slack",
    error,
    { messageId: "m1", deliveryCount: 1 },
    alwaysRetryable,
    noop,
  );
  // exponential = 2^1 * 5 = 10, retryAfterSeconds = 15 -> 15 wins
  assert.deepStrictEqual(result, { afterSeconds: 15 });
});

test("buildQueueConsumerRetry uses exponential when larger than retryAfterSeconds", () => {
  const error = Object.assign(new Error("retryable"), {
    retryAfterSeconds: 3,
  });
  const result = buildQueueConsumerRetry(
    "discord",
    error,
    { messageId: "m1", deliveryCount: 3 },
    alwaysRetryable,
    noop,
  );
  // exponential = 2^3 * 5 = 40, retryAfterSeconds = 3 -> 40 wins
  assert.deepStrictEqual(result, { afterSeconds: 40 });
});

test("buildQueueConsumerRetry caps retryAfterSeconds at max backoff", () => {
  const error = Object.assign(new Error("slow"), {
    retryAfterSeconds: 999,
  });
  const result = buildQueueConsumerRetry(
    "slack",
    error,
    { messageId: "m1", deliveryCount: 1 },
    alwaysRetryable,
    noop,
  );
  assert.deepStrictEqual(result, { afterSeconds: 300 });
});

test("buildQueueConsumerRetry ignores retryAfterSeconds on non-retryable errors", () => {
  const error = Object.assign(new Error("permanent"), {
    retryAfterSeconds: 15,
  });
  const result = buildQueueConsumerRetry(
    "telegram",
    error,
    { messageId: "m1", deliveryCount: 1 },
    neverRetryable,
    noop,
  );
  assert.deepStrictEqual(result, { acknowledge: true });
});

test("buildQueueConsumerRetry logs retryAfterSeconds when present", () => {
  const logged: Record<string, unknown>[] = [];
  const logFn = (_event: string, data: Record<string, unknown>) => {
    logged.push(data);
  };
  const error = Object.assign(new Error("sandbox_not_ready"), {
    retryAfterSeconds: 15,
  });
  buildQueueConsumerRetry(
    "slack",
    error,
    { messageId: "m1", deliveryCount: 1 },
    alwaysRetryable,
    logFn,
  );
  assert.equal(logged[0]?.retryAfterSeconds, 15);
});

test("buildQueueConsumerRetry does not log retryAfterSeconds when absent", () => {
  const logged: Record<string, unknown>[] = [];
  const logFn = (_event: string, data: Record<string, unknown>) => {
    logged.push(data);
  };
  buildQueueConsumerRetry(
    "slack",
    new Error("plain"),
    { messageId: "m1", deliveryCount: 1 },
    alwaysRetryable,
    logFn,
  );
  assert.equal("retryAfterSeconds" in (logged[0] ?? {}), false);
});

test("buildQueueConsumerRetry honors retryAfterSeconds=15 from sandbox wake error (RetryableChannelError pattern)", () => {
  // Simulates the error shape produced by processChannelJob when
  // ensureSandboxReady times out: RetryableChannelError("sandbox_not_ready: ...", 15)
  const error = Object.assign(
    new Error("sandbox_not_ready: Sandbox did not become ready within 25 seconds"),
    { name: "RetryableChannelError", retryAfterSeconds: 15 },
  );
  const logged: Array<{ event: string; data: Record<string, unknown> }> = [];
  const logFn = (event: string, data: Record<string, unknown>) => {
    logged.push({ event, data });
  };

  const result = buildQueueConsumerRetry(
    "slack",
    error,
    { messageId: "wake-test-1", deliveryCount: 1 },
    alwaysRetryable,
    logFn,
  );

  // retryAfterSeconds=15 beats exponential=10 (2^1 * 5 = 10)
  assert.deepStrictEqual(result, { afterSeconds: 15 });

  // Log should include retryAfterSeconds and error context
  assert.equal(logged[0]?.data?.retryAfterSeconds, 15);
  assert.equal(logged[0]?.data?.retryable, true);
  assert.match(String(logged[0]?.data?.error), /sandbox_not_ready/);
});

test("buildQueueConsumerRetry ceils fractional retryAfterSeconds", () => {
  const error = Object.assign(new Error("slow"), {
    retryAfterSeconds: 7.3,
  });
  const result = buildQueueConsumerRetry(
    "slack",
    error,
    { messageId: "m1", deliveryCount: 1 },
    alwaysRetryable,
    noop,
  );
  // ceil(7.3) = 8, exponential = 10 -> 10 wins
  assert.deepStrictEqual(result, { afterSeconds: 10 });

  // With lower exponential: deliveryCount=0 -> 2^0*5=5, ceil(7.3)=8 -> 8 wins
  const result2 = buildQueueConsumerRetry(
    "slack",
    error,
    { messageId: "m2", deliveryCount: 0 },
    alwaysRetryable,
    noop,
  );
  assert.deepStrictEqual(result2, { afterSeconds: 8 });
});
