/**
 * Reusable assertion helpers for vercel-openclaw scenario tests.
 *
 * These wrap common multi-step assertions (gateway requests, queue state,
 * session history, auth traffic) so individual tests stay concise.
 */

import assert from "node:assert/strict";

import type { CapturedRequest } from "@/test-utils/fake-fetch";
import type { Store } from "@/server/store/store";
import {
  channelQueueKey,
  channelProcessingKey,
  channelFailedKey,
} from "@/server/channels/keys";
import type { ChannelName } from "@/shared/channels";

// ---------------------------------------------------------------------------
// assertGatewayRequest
// ---------------------------------------------------------------------------

/**
 * Assert that a `/v1/chat/completions` request was made with the correct
 * Bearer token and optional session-key header.
 *
 * Returns the matched gateway request for further assertions.
 */
export function assertGatewayRequest(
  requests: CapturedRequest[],
  options: {
    gatewayToken: string;
    sessionKey?: string;
    /** Minimum number of gateway calls expected (default: 1). */
    minCalls?: number;
    /** The user message text that should appear in the request body. */
    userMessage?: string;
  },
): CapturedRequest {
  const gatewayRequests = requests.filter((r) =>
    r.url.includes("/v1/chat/completions"),
  );
  const minCalls = options.minCalls ?? 1;

  assert.ok(
    gatewayRequests.length >= minCalls,
    `Expected >= ${minCalls} gateway call(s), got ${gatewayRequests.length}`,
  );

  const gw = gatewayRequests[0]!;

  assert.equal(
    gw.headers?.["Authorization"],
    `Bearer ${options.gatewayToken}`,
    "Gateway request must include correct Bearer token",
  );

  if (options.sessionKey !== undefined) {
    assert.equal(
      gw.headers?.["x-openclaw-session-key"],
      options.sessionKey,
      "Gateway request must include correct session key header",
    );
  }

  if (options.userMessage !== undefined && gw.body) {
    const body = JSON.parse(gw.body);
    const lastMsg = body.messages[body.messages.length - 1];
    assert.equal(lastMsg.role, "user", "Last message should be from user");
    assert.equal(
      lastMsg.content,
      options.userMessage,
      "User message content mismatch",
    );
  }

  return gw;
}

// ---------------------------------------------------------------------------
// assertQueuesDrained
// ---------------------------------------------------------------------------

/**
 * Assert that the main queue, processing queue, and (optionally) failed
 * queue for a channel are all at expected lengths (default: empty).
 */
export async function assertQueuesDrained(
  store: Store,
  channel: ChannelName,
  options?: {
    queue?: number;
    processing?: number;
    failed?: number;
  },
): Promise<void> {
  const expectedQueue = options?.queue ?? 0;
  const expectedProcessing = options?.processing ?? 0;
  const expectedFailed = options?.failed ?? 0;

  assert.equal(
    await store.getQueueLength(channelQueueKey(channel)),
    expectedQueue,
    `${channel} main queue expected ${expectedQueue} item(s)`,
  );
  assert.equal(
    await store.getQueueLength(channelProcessingKey(channel)),
    expectedProcessing,
    `${channel} processing queue expected ${expectedProcessing} item(s)`,
  );
  assert.equal(
    await store.getQueueLength(channelFailedKey(channel)),
    expectedFailed,
    `${channel} failed queue expected ${expectedFailed} item(s)`,
  );
}

// ---------------------------------------------------------------------------
// assertHistory
// ---------------------------------------------------------------------------

/**
 * Assert that session history contains the expected messages in order.
 */
export function assertHistory(
  history: Array<{ role: string; content: string }> | null,
  expected: Array<{ role: string; content: string | ((c: string) => void) }>,
): void {
  assert.ok(Array.isArray(history), "Session history should be an array");
  const items = history as Array<{ role: string; content: string }>;
  assert.equal(
    items.length,
    expected.length,
    `History length: expected ${expected.length}, got ${items.length}`,
  );

  for (let i = 0; i < expected.length; i++) {
    const actual = items[i]!;
    const exp = expected[i]!;
    assert.equal(actual.role, exp.role, `history[${i}].role mismatch`);
    if (typeof exp.content === "function") {
      exp.content(actual.content);
    } else {
      assert.equal(
        actual.content,
        exp.content,
        `history[${i}].content mismatch`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// assertNoBrowserAuthTraffic
// ---------------------------------------------------------------------------

/**
 * Assert that no requests were made to browser auth endpoints
 * (Vercel OAuth token exchange, authorize URL).
 */
export function assertNoBrowserAuthTraffic(
  requests: CapturedRequest[],
): void {
  const authRequests = requests.filter(
    (r) =>
      r.url.includes("api.vercel.com/v2/oauth2/token") ||
      r.url.includes("vercel.com/oauth/authorize"),
  );
  assert.equal(
    authRequests.length,
    0,
    `Expected zero browser auth requests, got ${authRequests.length}: ${authRequests.map((r) => r.url).join(", ")}`,
  );
}
