/**
 * Smoke tests for POST /api/admin/ssh.
 *
 * Covers CSRF rejection, missing command validation, and sandbox-not-running.
 *
 * Run: pnpm test src/app/api/admin/ssh/route.test.ts
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
  buildPostRequest,
  buildAuthPostRequest,
  getAdminSshRoute,
  patchNextServerAfter,
  resetAfterCallbacks,
} from "@/test-utils/route-caller";
import { FakeSandboxController } from "@/test-utils/harness";

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
// POST /api/admin/ssh
// ===========================================================================

test("POST /api/admin/ssh: without CSRF headers returns 403", async () => {
  await withTestEnv(async () => {
    const route = getAdminSshRoute();
    const request = buildPostRequest("/api/admin/ssh", JSON.stringify({ command: "ls" }));
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 403);
    const body = result.json as { error: string };
    assert.ok(
      body.error === "CSRF_ORIGIN_MISMATCH" || body.error === "CSRF_HEADER_MISSING",
      `Expected CSRF error, got: ${body.error}`,
    );
  });
});

test("POST /api/admin/ssh: returns 409 when sandbox is not running", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.sandboxId = null;
    });

    const route = getAdminSshRoute();
    const request = buildAuthPostRequest(
      "/api/admin/ssh",
      JSON.stringify({ command: "ls" }),
    );
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 409);
    const body = result.json as { error: string };
    assert.equal(body.error, "SANDBOX_NOT_RUNNING");
  });
});

test("POST /api/admin/ssh: returns 400 for missing command", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-ssh-1";
    });

    const route = getAdminSshRoute();
    const request = buildAuthPostRequest("/api/admin/ssh", JSON.stringify({}));
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 400);
    const body = result.json as { error: string };
    assert.equal(body.error, "MISSING_COMMAND");
  });
});

test("POST /api/admin/ssh: returns 400 for invalid JSON", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-ssh-2";
    });

    const route = getAdminSshRoute();
    const request = buildAuthPostRequest("/api/admin/ssh", "not-json");
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 400);
    const body = result.json as { error: string };
    assert.equal(body.error, "INVALID_JSON");
  });
});

test("POST /api/admin/ssh: returns 400 for command exceeding max length", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-ssh-3";
    });

    const route = getAdminSshRoute();
    const longCommand = "x".repeat(2001);
    const request = buildAuthPostRequest(
      "/api/admin/ssh",
      JSON.stringify({ command: longCommand }),
    );
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 400);
    const body = result.json as { error: string };
    assert.equal(body.error, "COMMAND_TOO_LONG");
  });
});

test("POST /api/admin/ssh: returns 400 for too many args", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-ssh-4";
    });

    const route = getAdminSshRoute();
    const args = Array.from({ length: 21 }, (_, i) => `arg${i}`);
    const request = buildAuthPostRequest(
      "/api/admin/ssh",
      JSON.stringify({ command: "echo", args }),
    );
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 400);
    const body = result.json as { error: string };
    assert.equal(body.error, "TOO_MANY_ARGS");
  });
});
