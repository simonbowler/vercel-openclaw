/**
 * Auth token decay during sandbox sleep and channel-triggered restore.
 *
 * Validates:
 * 1. Channel drain after long sandbox sleep uses gateway token (not user auth)
 * 2. Failed token refresh during browser auth causes structured error
 * 3. Concurrent requireRouteAuth calls deduplicate to one refresh
 * 4. Refresh failure clears session and forces re-login on next browser request
 * 5. Channel webhooks still function when no browser auth exists
 *
 * Run: npm test src/server/channels/drain-auth-decay.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createScenarioHarness,
  dumpDiagnostics,
} from "@/test-utils/harness";
import {
  assertGatewayRequest,
  assertQueuesDrained,
  assertNoBrowserAuthTraffic,
} from "@/test-utils/assertions";
import { buildSlackWebhook } from "@/test-utils/webhook-builders";
import { stopSandbox } from "@/server/sandbox/lifecycle";
import { enqueueChannelJob } from "@/server/channels/driver";
import { drainSlackQueue } from "@/server/channels/slack/runtime";
import { requireRouteAuth } from "@/server/auth/vercel-auth";
import {
  serializeSessionCookie,
  SESSION_COOKIE_NAME,
} from "@/server/auth/session";
import type { AuthSession } from "@/server/auth/session";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function configureSlack(h: { mutateMeta: typeof import("@/server/store/store").mutateMeta }): string {
  const slackSigningSecret = "test-slack-signing-secret-auth-decay";
  h.mutateMeta((meta) => {
    meta.channels.slack = {
      signingSecret: slackSigningSecret,
      botToken: "xoxb-auth-decay-test-bot-token",
      configuredAt: Date.now(),
    };
  });
  return slackSigningSecret;
}

async function enqueueSlackJob(
  h: { fakeFetch: { fetch: typeof fetch } },
  signingSecret: string,
): Promise<void> {
  const slackReq = buildSlackWebhook({
    signingSecret,
    payload: {
      type: "event_callback",
      event_id: `Ev${Date.now()}`,
      event: {
        type: "message",
        text: "auth decay test message",
        channel: "C-AUTH-DECAY",
        ts: `${Date.now()}.000001`,
        thread_ts: `${Date.now()}.000000`,
        user: "U-AUTH-DECAY",
      },
    },
  });
  const slackPayload = JSON.parse(await slackReq.text());
  await enqueueChannelJob("slack", {
    payload: slackPayload,
    receivedAt: Date.now(),
    origin: "https://test.example.com",
  });
}

/** Build a fake expired session for browser auth testing. */
function makeExpiredSession(): AuthSession {
  return {
    accessToken: "expired-access-token",
    refreshToken: "expired-refresh-token",
    expiresAt: Date.now() - 60_000, // expired 1 minute ago
    user: {
      sub: "user-auth-decay-test",
      email: "test@example.com",
      name: "Auth Decay Tester",
    },
  };
}

/** Build a fake valid session. */
function makeValidSession(): AuthSession {
  return {
    accessToken: "valid-access-token",
    refreshToken: "valid-refresh-token",
    expiresAt: Date.now() + 3600_000, // valid for 1 hour
    user: {
      sub: "user-auth-decay-test",
      email: "test@example.com",
      name: "Auth Decay Tester",
    },
  };
}

/** Build a request with a session cookie. */
async function buildAuthedRequest(
  session: AuthSession,
  path = "/admin",
): Promise<Request> {
  const cookie = await serializeSessionCookie(session, false);
  // Extract the cookie value from the Set-Cookie header
  const cookieValue = cookie.split(";")[0]!;
  return new Request(`https://test.example.com${path}`, {
    headers: {
      cookie: cookieValue,
      "x-forwarded-proto": "https",
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("Auth Decay: channel drain after long sandbox sleep uses gateway token, not user auth", async (t) => {
  const h = createScenarioHarness();
  try {
    const signingSecret = configureSlack(h);
    await h.driveToRunning();
    const runningMeta = await h.getMeta();
    const gatewayToken = runningMeta.gatewayToken;
    assert.ok(gatewayToken, "Gateway token must be set after bootstrap");

    // Simulate long sleep: stop sandbox
    await stopSandbox();
    assert.equal((await h.getMeta()).status, "stopped");

    h.installDefaultGatewayHandlers();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      await enqueueSlackJob(h, signingSecret);

      const store = h.getStore();
      assert.equal(await store.getQueueLength("openclaw-single:channels:slack:queue"), 1);

      // Drain triggers restore and uses gateway token
      await drainSlackQueue();

      // Verify the gateway request used the gateway token (not any browser auth)
      assertGatewayRequest(h.fakeFetch.requests(), {
        gatewayToken: gatewayToken!,
      });

      // No browser auth traffic
      assertNoBrowserAuthTraffic(h.fakeFetch.requests());

      // Queues should be empty
      await assertQueuesDrained(store, "slack");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    h.teardown();
  }
});

test("Auth Decay: failed token refresh causes structured 401 error with session clear", async (t) => {
  const h = createScenarioHarness();
  try {
    // Set auth mode to sign-in-with-vercel so requireRouteAuth actually checks tokens
    process.env.VERCEL_AUTH_MODE = "sign-in-with-vercel";
    process.env.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID = "test-client-id";
    process.env.VERCEL_APP_CLIENT_SECRET = "test-client-secret";

    const expiredSession = makeExpiredSession();
    const request = await buildAuthedRequest(expiredSession);

    // Mock the Vercel token endpoint to fail
    h.fakeFetch.onPost(/api\.vercel\.com\/v2\/oauth2\/token/, () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      const result = await requireRouteAuth(request, { mode: "json" });

      // Should return a Response (not an AuthCheckResult) because refresh failed
      assert.ok(result instanceof Response, "Should return a Response on refresh failure");
      assert.equal(result.status, 401, "Status should be 401");

      const body = await result.json();
      assert.equal(body.error, "UNAUTHORIZED", "Error code should be UNAUTHORIZED");
      assert.ok(body.authorizeUrl, "Should include authorize URL for re-login");

      // Should have a Set-Cookie header clearing the session
      const setCookie = result.headers.get("set-cookie");
      assert.ok(setCookie, "Should have Set-Cookie header");
      assert.ok(
        setCookie.includes(SESSION_COOKIE_NAME),
        "Set-Cookie should reference session cookie name",
      );
      assert.ok(
        setCookie.includes("Max-Age=0"),
        "Set-Cookie should clear the cookie (Max-Age=0)",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    delete process.env.VERCEL_AUTH_MODE;
    delete process.env.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID;
    delete process.env.VERCEL_APP_CLIENT_SECRET;
    h.teardown();
  }
});

test("Auth Decay: concurrent requireRouteAuth calls deduplicate to one refresh", async (t) => {
  const h = createScenarioHarness();
  try {
    process.env.VERCEL_AUTH_MODE = "sign-in-with-vercel";
    process.env.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID = "test-client-id";
    process.env.VERCEL_APP_CLIENT_SECRET = "test-client-secret";

    const expiredSession = makeExpiredSession();

    let tokenCallCount = 0;
    h.fakeFetch.onPost(/api\.vercel\.com\/v2\/oauth2\/token/, async () => {
      tokenCallCount++;
      // Add a small delay so concurrent callers hit the dedup window
      await new Promise((r) => setTimeout(r, 50));
      return Response.json({
        access_token: "refreshed-access-token",
        refresh_token: "refreshed-refresh-token",
        expires_in: 3600,
        // No id_token — will carry forward previous user info
      });
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      // Fire 3 concurrent requests with the same expired session
      const [req1, req2, req3] = await Promise.all([
        buildAuthedRequest(expiredSession, "/admin"),
        buildAuthedRequest(expiredSession, "/admin/settings"),
        buildAuthedRequest(expiredSession, "/gateway"),
      ]);

      const [result1, result2, result3] = await Promise.all([
        requireRouteAuth(req1, { mode: "json" }),
        requireRouteAuth(req2, { mode: "json" }),
        requireRouteAuth(req3, { mode: "json" }),
      ]);

      // All should succeed (not be Response objects)
      assert.ok(
        !(result1 instanceof Response),
        "First request should get refreshed session",
      );
      assert.ok(
        !(result2 instanceof Response),
        "Second request should get refreshed session",
      );
      assert.ok(
        !(result3 instanceof Response),
        "Third request should get refreshed session",
      );

      // Only one token exchange should have happened (deduplication)
      assert.equal(
        tokenCallCount,
        1,
        "Should deduplicate to exactly one token refresh call",
      );

      // All results should have the refreshed token
      const s1 = (result1 as { session: AuthSession }).session;
      const s2 = (result2 as { session: AuthSession }).session;
      const s3 = (result3 as { session: AuthSession }).session;
      assert.equal(s1.accessToken, "refreshed-access-token");
      assert.equal(s2.accessToken, "refreshed-access-token");
      assert.equal(s3.accessToken, "refreshed-access-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    delete process.env.VERCEL_AUTH_MODE;
    delete process.env.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID;
    delete process.env.VERCEL_APP_CLIENT_SECRET;
    h.teardown();
  }
});

test("Auth Decay: refresh failure clears session and forces re-login on next browser request", async (t) => {
  const h = createScenarioHarness();
  try {
    process.env.VERCEL_AUTH_MODE = "sign-in-with-vercel";
    process.env.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID = "test-client-id";
    process.env.VERCEL_APP_CLIENT_SECRET = "test-client-secret";

    const expiredSession = makeExpiredSession();

    // Token endpoint returns 401 (expired refresh token)
    h.fakeFetch.onPost(/api\.vercel\.com\/v2\/oauth2\/token/, () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 }),
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      // First request: expired token → refresh fails → clear session + redirect
      const request = await buildAuthedRequest(expiredSession);
      const result = await requireRouteAuth(request, { mode: "redirect" });

      assert.ok(result instanceof Response, "Should return a redirect Response");
      assert.equal(result.status, 302, "Should redirect for re-login");

      const location = result.headers.get("location");
      assert.ok(location, "Should have Location header");
      assert.ok(
        location.includes("/api/auth/authorize"),
        "Should redirect to authorize endpoint",
      );

      // Verify session cookie is cleared
      const setCookieHeaders = result.headers.getSetCookie
        ? result.headers.getSetCookie()
        : [result.headers.get("set-cookie")].filter(Boolean);
      const sessionClear = setCookieHeaders.find((h) =>
        h?.includes(SESSION_COOKIE_NAME),
      );
      assert.ok(sessionClear, "Session cookie should be cleared");
      assert.ok(
        sessionClear!.includes("Max-Age=0"),
        "Session cookie Max-Age should be 0",
      );

      // Second request with no session cookie → also gets redirect (no stale session)
      const freshRequest = new Request("https://test.example.com/admin", {
        headers: { "x-forwarded-proto": "https" },
      });
      const result2 = await requireRouteAuth(freshRequest, { mode: "json" });
      assert.ok(result2 instanceof Response, "No-cookie request should get 401");
      assert.equal(result2.status, 401);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    delete process.env.VERCEL_AUTH_MODE;
    delete process.env.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID;
    delete process.env.VERCEL_APP_CLIENT_SECRET;
    h.teardown();
  }
});

test("Auth Decay: channel webhooks function when no browser auth session exists", async (t) => {
  const h = createScenarioHarness();
  try {
    const signingSecret = configureSlack(h);
    await h.driveToRunning();
    const runningMeta = await h.getMeta();
    const gatewayToken = runningMeta.gatewayToken;

    // Do NOT create any browser auth session at all.
    // Stop and restore to simulate sleep cycle.
    await stopSandbox();
    assert.equal((await h.getMeta()).status, "stopped");

    h.installDefaultGatewayHandlers();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      await enqueueSlackJob(h, signingSecret);

      const store = h.getStore();
      assert.equal(await store.getQueueLength("openclaw-single:channels:slack:queue"), 1);

      // Drain should work without any browser session
      await drainSlackQueue();

      // Gateway was called with the gateway token
      assertGatewayRequest(h.fakeFetch.requests(), {
        gatewayToken: gatewayToken!,
      });

      // Slack reply was sent
      const slackRequests = h.fakeFetch
        .requests()
        .filter((r) => r.url.includes("slack.com/api/chat.postMessage"));
      assert.ok(slackRequests.length >= 1, "Slack reply should be sent");

      // No browser auth endpoint was contacted
      assertNoBrowserAuthTraffic(h.fakeFetch.requests());

      // Queues empty
      await assertQueuesDrained(store, "slack");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    h.teardown();
  }
});
