/**
 * Tests for the Discord Vercel Queue consumer retry logic.
 *
 * Tests buildQueueConsumerRetry with Discord-specific scenarios:
 * retryable vs non-retryable errors, delivery count exhaustion,
 * AbortError handling, and exponential backoff.
 *
 * Run: npm test src/app/api/queues/channels/discord/route.test.ts
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
    "discord",
    error,
    { messageId: "test-msg-id", deliveryCount },
    isRetryable,
    noopLog,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("Discord queue retry: non-retryable error returns acknowledge", () => {
  const result = retry(new Error("permanent_failure"), 1);
  assert.deepEqual(result, { acknowledge: true });
});

test("Discord queue retry: retryable error returns afterSeconds", () => {
  const err = new Error("fetch failed");
  const result = retry(err, 2);
  assert.ok("afterSeconds" in result);
  // 2^2 * 5 = 20
  assert.equal((result as { afterSeconds: number }).afterSeconds, 20);
});

test("Discord queue retry: delivery count > 8 acknowledges", () => {
  const err = new Error("fetch failed");
  const result = retry(err, 9);
  assert.deepEqual(result, { acknowledge: true });
});

test("Discord queue retry: exponential backoff values", () => {
  const err = new Error("fetch failed");

  const cases = [
    { deliveryCount: 1, expected: 10 },
    { deliveryCount: 3, expected: 40 },
    { deliveryCount: 5, expected: 160 },
    { deliveryCount: 7, expected: 300 }, // 2^7 * 5 = 640 → capped
  ];

  for (const { deliveryCount, expected } of cases) {
    const result = retry(err, deliveryCount);
    assert.ok("afterSeconds" in result);
    assert.equal(
      (result as { afterSeconds: number }).afterSeconds,
      expected,
      `deliveryCount ${deliveryCount}: expected ${expected}s`,
    );
  }
});

test("Discord queue retry: RetryableSendError is retryable", () => {
  const err = new RetryableSendError("discord_api_error", {
    retryAfterSeconds: 10,
  });
  const result = retry(err, 1);
  assert.ok("afterSeconds" in result);
});

test("Discord queue retry: AbortError is retryable", () => {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  const result = retry(err, 4);
  assert.ok("afterSeconds" in result);
  // 2^4 * 5 = 80
  assert.equal((result as { afterSeconds: number }).afterSeconds, 80);
});

test("Discord queue retry: string error is non-retryable", () => {
  const result = retry("some string error", 1);
  assert.deepEqual(result, { acknowledge: true });
});

test("Discord queue retry: null error is non-retryable", () => {
  const result = retry(null, 1);
  assert.deepEqual(result, { acknowledge: true });
});
