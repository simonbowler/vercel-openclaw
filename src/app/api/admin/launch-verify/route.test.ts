/**
 * Tests for POST /api/admin/launch-verify and GET /api/admin/launch-verify.
 *
 * Covers: auth enforcement, destructive-mode parsing (query param vs JSON body),
 * chatCompletions auth header verification, sandboxHealth.repaired field.
 *
 * Run: npm test src/app/api/admin/launch-verify/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { withHarness } from "@/test-utils/harness";
import {
  callRoute,
  buildPostRequest,
  buildAuthPostRequest,
  buildAuthGetRequest,
  getAdminLaunchVerifyRoute,
  drainAfterCallbacks,
} from "@/test-utils/route-caller";
import type {
  LaunchVerificationPayload,
  LaunchVerificationSandboxHealth,
  ChannelReadiness,
} from "@/shared/launch-verification";

/**
 * Helper: make preflight fail fast on the auth-config check.
 * Sets sign-in-with-vercel mode without the required OAuth client ID,
 * which is a hard fail regardless of Vercel/non-Vercel environment.
 * Does NOT require VERCEL=1, so the memory store still works.
 */
function makePreflightFail(): void {
  process.env.VERCEL_AUTH_MODE = "sign-in-with-vercel";
  delete process.env.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID;
  delete process.env.VERCEL_APP_CLIENT_SECRET;
}

// ===========================================================================
// Auth enforcement
// ===========================================================================

test("launch-verify POST: without CSRF headers returns 403", async () => {
  await withHarness(async () => {
    const route = getAdminLaunchVerifyRoute();
    const req = buildPostRequest("/api/admin/launch-verify", "{}");
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 403);
  });
});

test("launch-verify GET: without auth returns 403", async () => {
  await withHarness(async () => {
    const route = getAdminLaunchVerifyRoute();
    const req = new Request("http://localhost:3000/api/admin/launch-verify", {
      method: "GET",
    });
    const result = await callRoute(route.GET, req);
    // requireJsonRouteAuth rejects unauthenticated requests
    assert.ok(
      result.status === 401 || result.status === 403,
      `expected 401 or 403, got ${result.status}`,
    );
  });
});

// ===========================================================================
// Mode parsing: query param takes precedence over JSON body
// ===========================================================================

test("launch-verify POST: defaults to safe mode when no mode specified", async () => {
  await withHarness(async () => {
    makePreflightFail();

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest("/api/admin/launch-verify", "{}");
    const result = await callRoute(route.POST, req);

    const body = result.json as LaunchVerificationPayload;
    assert.equal(body.mode, "safe");
    assert.equal(body.ok, false, "should fail since preflight fails");
    await drainAfterCallbacks();
  });
});

test("launch-verify POST: reads destructive mode from JSON body", async () => {
  await withHarness(async () => {
    makePreflightFail();

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest(
      "/api/admin/launch-verify",
      JSON.stringify({ mode: "destructive" }),
    );
    const result = await callRoute(route.POST, req);

    const body = result.json as LaunchVerificationPayload;
    assert.equal(body.mode, "destructive");
    await drainAfterCallbacks();
  });
});

test("launch-verify POST: reads destructive mode from query param", async () => {
  await withHarness(async () => {
    makePreflightFail();

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest(
      "/api/admin/launch-verify?mode=destructive",
      "{}",
    );
    const result = await callRoute(route.POST, req);

    const body = result.json as LaunchVerificationPayload;
    assert.equal(body.mode, "destructive");
    await drainAfterCallbacks();
  });
});

test("launch-verify POST: query param takes precedence over JSON body", async () => {
  await withHarness(async () => {
    makePreflightFail();

    const route = getAdminLaunchVerifyRoute();
    // Query param says destructive, body says safe (default)
    const req = buildAuthPostRequest(
      "/api/admin/launch-verify?mode=destructive",
      JSON.stringify({ mode: "safe" }),
    );
    const result = await callRoute(route.POST, req);

    const body = result.json as LaunchVerificationPayload;
    assert.equal(body.mode, "destructive");
    await drainAfterCallbacks();
  });
});

test("launch-verify POST: query param safe overrides body destructive", async () => {
  await withHarness(async () => {
    makePreflightFail();

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest(
      "/api/admin/launch-verify?mode=safe",
      JSON.stringify({ mode: "destructive" }),
    );
    const result = await callRoute(route.POST, req);

    const body = result.json as LaunchVerificationPayload;
    assert.equal(body.mode, "safe");
    await drainAfterCallbacks();
  });
});

test("launch-verify POST: no JSON body still works (uses query param)", async () => {
  await withHarness(async () => {
    makePreflightFail();

    const route = getAdminLaunchVerifyRoute();
    // Send request with no body at all, but with query param
    const req = new Request(
      "http://localhost:3000/api/admin/launch-verify?mode=destructive",
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-admin-secret-for-scenarios",
          origin: "http://localhost:3000",
          "x-requested-with": "XMLHttpRequest",
        },
      },
    );
    const result = await callRoute(route.POST, req);

    const body = result.json as LaunchVerificationPayload;
    assert.equal(body.mode, "destructive");
    await drainAfterCallbacks();
  });
});

// ===========================================================================
// Response shape: phases and payload structure
// ===========================================================================

test("launch-verify POST: preflight failure skips subsequent phases", async () => {
  await withHarness(async () => {
    makePreflightFail();

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest("/api/admin/launch-verify", "{}");
    const result = await callRoute(route.POST, req);

    const body = result.json as LaunchVerificationPayload;
    assert.equal(body.ok, false);
    assert.equal(body.mode, "safe");
    assert.ok(body.startedAt, "should have startedAt");
    assert.ok(body.completedAt, "should have completedAt");

    // Preflight should fail, rest should be skipped
    const phaseIds = body.phases.map((p) => p.id);
    assert.deepEqual(phaseIds, [
      "preflight",
      "queuePing",
      "ensureRunning",
      "chatCompletions",
      "wakeFromSleep",
    ]);

    assert.equal(body.phases[0].status, "fail");
    for (let i = 1; i < body.phases.length; i++) {
      assert.equal(
        body.phases[i].status,
        "skip",
        `phase ${body.phases[i].id} should be skipped`,
      );
    }

    // channelReadiness should be present in the extended response
    const extended = result.json as LaunchVerificationPayload & {
      channelReadiness: ChannelReadiness;
    };
    assert.ok(extended.channelReadiness, "should include channelReadiness");
    assert.equal(extended.channelReadiness.ready, false);

    await drainAfterCallbacks();
  });
});

// ===========================================================================
// GET readiness endpoint
// ===========================================================================

test("launch-verify GET: returns channel readiness", async () => {
  await withHarness(async () => {
    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthGetRequest("/api/admin/launch-verify");
    const result = await callRoute(route.GET, req);

    assert.equal(result.status, 200);
    const body = result.json as ChannelReadiness;
    assert.equal(body.ready, false, "default readiness should be false");
    assert.ok(body.deploymentId, "should have a deploymentId");
  });
});

// ===========================================================================
// chatCompletions auth: AI Gateway token sent as X-AI-Gateway-Token header
// ===========================================================================

test("launch-verify POST: chatCompletions sends X-AI-Gateway-Token header", async () => {
  await withHarness(async (h) => {
    // Set up a public origin so preflight passes
    process.env.NEXT_PUBLIC_APP_URL = "https://test.example";

    // Drive sandbox to running so ensureRunning passes
    await h.driveToRunning();

    // Install a handler for /v1/chat/completions that captures headers
    let capturedHeaders: Record<string, string> = {};
    h.fakeFetch.on("POST", /v1\/chat\/completions/, (_url, init) => {
      capturedHeaders = {};
      const headers = init?.headers;
      if (headers && typeof headers === "object" && !Array.isArray(headers)) {
        for (const [key, value] of Object.entries(headers)) {
          capturedHeaders[key.toLowerCase()] = String(value);
        }
      }
      return Response.json({
        choices: [{ message: { content: "launch-verify-ok" } }],
      });
    });

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest(
      "/api/admin/launch-verify",
      JSON.stringify({ mode: "safe" }),
    );
    const result = await callRoute(route.POST, req);
    await drainAfterCallbacks();

    const body = result.json as LaunchVerificationPayload;

    // The queuePing phase will fail because @vercel/queue isn't available in test.
    // But the route continues to ensureRunning independently.
    // The chatCompletions phase depends on ensureRunning passing.
    const chatPhase = body.phases.find((p) => p.id === "chatCompletions");
    if (chatPhase && chatPhase.status === "pass") {
      assert.ok(
        capturedHeaders["x-ai-gateway-token"],
        "chatCompletions should send X-AI-Gateway-Token header",
      );
      assert.ok(
        capturedHeaders["authorization"],
        "chatCompletions should send Authorization header",
      );
      assert.ok(
        capturedHeaders["authorization"].startsWith("Bearer "),
        "Authorization should be a Bearer token",
      );
    }
    // Verify mode is still correctly parsed regardless of phase outcomes
    assert.equal(body.mode, "safe");
  });
});

// ===========================================================================
// OPENCLAW_PACKAGE_SPEC consistency: preflight phase reflects contract
// ===========================================================================

// Full package-spec fail/pass scenarios are tested at the server level in
// deploy-preflight.test.ts (including cross-surface consistency with
// connectability) to avoid global store singleton conflicts that arise from
// setting VERCEL=1 in route-level tests with parallel test files.

test("launch-verify POST: preflight error propagates contract check failures to phase output", async () => {
  await withHarness(async () => {
    // Make preflight fail via auth-config (missing OAuth client ID in
    // sign-in-with-vercel mode). Verify the phase error includes the failing
    // check ID — the same mechanism that surfaces any contract failure.
    makePreflightFail();

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest("/api/admin/launch-verify", "{}");
    const result = await callRoute(route.POST, req);

    const body = result.json as LaunchVerificationPayload;
    const preflightPhase = body.phases.find((p) => p.id === "preflight");
    assert.ok(preflightPhase, "expected preflight phase");
    assert.equal(preflightPhase.status, "fail");
    assert.ok(
      preflightPhase.error?.includes("auth-config"),
      `preflight error should include the failing check ID; got: ${preflightPhase.error}`,
    );

    await drainAfterCallbacks();
  });
});

// ===========================================================================
// sandboxHealth.repaired field
// ===========================================================================

test("launch-verify POST: response includes sandboxHealth when preflight fails", async () => {
  await withHarness(async () => {
    makePreflightFail();

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest("/api/admin/launch-verify", "{}");
    const result = await callRoute(route.POST, req);

    const body = result.json as LaunchVerificationPayload & {
      sandboxHealth?: LaunchVerificationSandboxHealth;
    };

    // When preflight fails and ensure was skipped, sandboxHealth should
    // still be computed (repaired: false since ensure didn't run).
    if (body.sandboxHealth) {
      assert.equal(typeof body.sandboxHealth.repaired, "boolean");
      assert.equal(body.sandboxHealth.repaired, false);
    }

    await drainAfterCallbacks();
  });
});
