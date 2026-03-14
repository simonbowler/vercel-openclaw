/**
 * Smoke tests for GET/POST /api/status.
 *
 * Covers:
 * - GET returns status for both running and uninitialized sandbox states
 * - POST heartbeat with CSRF verification
 *
 * Run: pnpm test src/app/api/status/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { _setSandboxControllerForTesting } from "@/server/sandbox/controller";
import {
  _resetStoreForTesting,
  mutateMeta,
} from "@/server/store/store";
import {
  callRoute,
  buildGetRequest,
  buildPostRequest,
  buildAuthGetRequest,
  buildAuthPostRequest,
  getStatusRoute,
  patchNextServerAfter,
  resetAfterCallbacks,
} from "@/test-utils/route-caller";
import { FakeSandboxController } from "@/test-utils/harness";

// Patch before loading routes
patchNextServerAfter();

// ---------------------------------------------------------------------------
// Environment isolation
// ---------------------------------------------------------------------------

async function withTestEnv(fn: () => Promise<void>): Promise<void> {
  const keys = [
    "NODE_ENV",
    "VERCEL",
    "VERCEL_AUTH_MODE",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
    "AI_GATEWAY_API_KEY",
    "VERCEL_OIDC_TOKEN",
    "NEXT_PUBLIC_APP_URL",
    "NEXT_PUBLIC_BASE_DOMAIN",
    "BASE_DOMAIN",
    "ADMIN_SECRET",
    "SESSION_SECRET",
  ];
  const originals: Record<string, string | undefined> = {};

  for (const key of keys) {
    originals[key] = process.env[key];
  }

  (process.env as Record<string, string | undefined>)["NODE_ENV"] = "test";
  delete process.env.VERCEL;
  delete process.env.VERCEL_AUTH_MODE;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.VERCEL_OIDC_TOKEN;
  process.env.NEXT_PUBLIC_BASE_DOMAIN = "http://localhost:3000";
  process.env.ADMIN_SECRET = "test-admin-secret-for-scenarios";
  process.env.SESSION_SECRET = "test-session-secret-for-smoke-tests";

  _resetStoreForTesting();

  try {
    await fn();
  } finally {
    for (const key of keys) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
    _resetStoreForTesting();
    resetAfterCallbacks();
    _setSandboxControllerForTesting(null);
  }
}

// ===========================================================================
// GET /api/status
// ===========================================================================

test("GET /api/status: returns uninitialized status by default", async () => {
  await withTestEnv(async () => {
    const route = getStatusRoute();
    const request = buildAuthGetRequest("/api/status");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as { status: string; storeBackend: string };
    assert.equal(body.status, "uninitialized");
    assert.equal(body.storeBackend, "memory");
  });
});

test("GET /api/status: returns running status when sandbox is running", async () => {
  await withTestEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-test-run";
    });

    const route = getStatusRoute();
    const request = buildAuthGetRequest("/api/status");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      status: string;
      sandboxId: string;
      gatewayReady: boolean;
    };
    assert.equal(body.status, "running");
    assert.equal(body.sandboxId, "sbx-test-run");
    assert.equal(body.gatewayReady, true);
  });
});

test("GET /api/status: includes firewall and channel state", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.firewall.mode = "learning";
    });

    const route = getStatusRoute();
    const request = buildAuthGetRequest("/api/status");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      firewall: { mode: string };
      channels: unknown;
    };
    assert.equal(body.firewall.mode, "learning");
    assert.ok("channels" in body, "should include channels");
  });
});

// ===========================================================================
// POST /api/status (heartbeat)
// ===========================================================================

test("POST /api/status: heartbeat without CSRF returns 403", async () => {
  await withTestEnv(async () => {
    const route = getStatusRoute();
    const request = buildPostRequest("/api/status", "{}");
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 403);
    const body = result.json as { error: string };
    assert.ok(
      body.error === "CSRF_ORIGIN_MISMATCH" || body.error === "CSRF_HEADER_MISSING",
      `Expected CSRF error, got: ${body.error}`,
    );
  });
});

test("POST /api/status: heartbeat with CSRF returns ok when sandbox is running", async () => {
  await withTestEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-heartbeat";
    });

    const route = getStatusRoute();
    const request = buildAuthPostRequest("/api/status", "{}");
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 200);
    const body = result.json as { ok: boolean; status: string };
    assert.equal(body.ok, true);
    assert.equal(body.status, "running");
  });
});
