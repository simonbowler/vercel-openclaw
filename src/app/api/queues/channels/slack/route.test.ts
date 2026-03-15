/**
 * Tests for the Slack Vercel Queue consumer retry logic.
 *
 * Tests buildQueueConsumerRetry with Slack-specific scenarios:
 * retryable vs non-retryable errors, delivery count exhaustion,
 * exponential backoff, and boundary conditions.
 *
 * Run: npm test src/app/api/queues/channels/slack/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { isRetryable } from "@/server/channels/driver";
import { buildQueueConsumerRetry } from "@/server/channels/queue";
import { RetryableSendError } from "@/server/channels/core/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopLog = () => {};

function retry(error: unknown, deliveryCount: number) {
  return buildQueueConsumerRetry(
    "slack",
    error,
    { messageId: "test-msg-id", deliveryCount },
    isRetryable,
    noopLog,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("Slack queue retry: non-retryable error returns acknowledge", () => {
  const result = retry(new Error("permanent_auth_failure"), 1);
  assert.deepEqual(result, { acknowledge: true });
});

test("Slack queue retry: retryable error returns afterSeconds", () => {
  const err = new Error("fetch failed");
  const result = retry(err, 1);
  assert.ok("afterSeconds" in result);
  // 2^1 * 5 = 10
  assert.equal((result as { afterSeconds: number }).afterSeconds, 10);
});

test("Slack queue retry: delivery count > 8 returns acknowledge even for retryable error", () => {
  const err = new Error("fetch failed");
  const result = retry(err, 9);
  assert.deepEqual(result, { acknowledge: true });
});

test("Slack queue retry: exponential backoff capped at 300s", () => {
  const err = new Error("request timed out");
  err.name = "TimeoutError";

  const cases = [
    { deliveryCount: 1, expected: 10 },    // 2^1 * 5
    { deliveryCount: 2, expected: 20 },    // 2^2 * 5
    { deliveryCount: 3, expected: 40 },    // 2^3 * 5
    { deliveryCount: 4, expected: 80 },    // 2^4 * 5
    { deliveryCount: 5, expected: 160 },   // 2^5 * 5
    { deliveryCount: 6, expected: 300 },   // 2^6 * 5 = 320 → capped
    { deliveryCount: 7, expected: 300 },   // 2^7 * 5 = 640 → capped
    { deliveryCount: 8, expected: 300 },   // 2^8 * 5 = 1280 → capped
  ];

  for (const { deliveryCount, expected } of cases) {
    const result = retry(err, deliveryCount);
    assert.ok("afterSeconds" in result, `deliveryCount ${deliveryCount} should retry`);
    assert.equal(
      (result as { afterSeconds: number }).afterSeconds,
      expected,
      `deliveryCount ${deliveryCount}: expected ${expected}s`,
    );
  }
});

test("Slack queue retry: RetryableSendError is retryable", () => {
  const err = new RetryableSendError("platform_rate_limited", {
    retryAfterSeconds: 30,
  });
  const result = retry(err, 2);
  assert.ok("afterSeconds" in result);
});

test("Slack queue retry: delivery count 8 still retries (boundary)", () => {
  const err = new Error("fetch failed");
  const result = retry(err, 8);
  assert.ok("afterSeconds" in result, "deliveryCount 8 should still retry (> 8 is the cutoff)");
});

test("Slack queue retry: logs error details", () => {
  const logged: Array<{ event: string; data: Record<string, unknown> }> = [];
  const logFn = (event: string, data: Record<string, unknown>) => {
    logged.push({ event, data });
  };

  buildQueueConsumerRetry(
    "slack",
    new Error("some error"),
    { messageId: "msg-1", deliveryCount: 1 },
    isRetryable,
    logFn,
  );

  assert.equal(logged.length, 1);
  assert.equal(logged[0].event, "channels.queue_consumer_error");
  assert.equal(logged[0].data.channel, "slack");
  assert.equal(logged[0].data.messageId, "msg-1");
});

test("Slack queue retry: logs exhaustion when delivery count exceeded", () => {
  const logged: Array<{ event: string; data: Record<string, unknown> }> = [];
  const logFn = (event: string, data: Record<string, unknown>) => {
    logged.push({ event, data });
  };

  buildQueueConsumerRetry(
    "slack",
    new Error("fetch failed"),
    { messageId: "msg-2", deliveryCount: 9 },
    isRetryable,
    logFn,
  );

  assert.equal(logged.length, 2);
  assert.equal(logged[1].event, "channels.queue_consumer_exhausted");
});
