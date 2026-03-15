/**
 * Tests for the Telegram Vercel Queue consumer retry logic.
 *
 * Tests buildQueueConsumerRetry with Telegram-specific scenarios:
 * retryable vs non-retryable errors, delivery count exhaustion,
 * and boundary conditions.
 *
 * Run: npm test src/app/api/queues/channels/telegram/route.test.ts
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
    "telegram",
    error,
    { messageId: "test-msg-id", deliveryCount },
    isRetryable,
    noopLog,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("Telegram queue retry: non-retryable error returns acknowledge", () => {
  const result = retry(new Error("permanent_failure"), 1);
  assert.deepEqual(result, { acknowledge: true });
});

test("Telegram queue retry: retryable error returns afterSeconds", () => {
  const err = new Error("fetch failed");
  const result = retry(err, 1);
  assert.ok("afterSeconds" in result);
  assert.equal((result as { afterSeconds: number }).afterSeconds, 10);
});

test("Telegram queue retry: delivery count > 8 acknowledges retryable error", () => {
  const err = new Error("fetch failed");
  const result = retry(err, 9);
  assert.deepEqual(result, { acknowledge: true });
});

test("Telegram queue retry: backoff caps at 300s", () => {
  const err = new Error("network timeout");
  err.name = "TimeoutError";

  // deliveryCount 6 → 2^6 * 5 = 320 → capped at 300
  const result = retry(err, 6);
  assert.ok("afterSeconds" in result);
  assert.equal((result as { afterSeconds: number }).afterSeconds, 300);
});

test("Telegram queue retry: RetryableSendError is retryable and honors retryAfterSeconds", () => {
  const err = new RetryableSendError("telegram_api_rate_limited", {
    retryAfterSeconds: 60,
  });
  const result = retry(err, 3);
  assert.ok("afterSeconds" in result);
  // 2^3 * 5 = 40 exponential, retryAfterSeconds = 60 → 60 wins
  assert.equal((result as { afterSeconds: number }).afterSeconds, 60);
});

test("Telegram queue retry: boundary - 8 retries, 9 acknowledges", () => {
  const err = new Error("fetch failed");

  const result8 = retry(err, 8);
  assert.ok("afterSeconds" in result8, "deliveryCount 8 should still retry");

  const result9 = retry(err, 9);
  assert.deepEqual(result9, { acknowledge: true }, "deliveryCount 9 should acknowledge");
});

test("Telegram queue retry: string error is non-retryable", () => {
  const result = retry("some string error", 1);
  assert.deepEqual(result, { acknowledge: true });
});
