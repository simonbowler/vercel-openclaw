/**
 * Smoke tests for GET/POST /api/cron/drain-channels.
 *
 * Covers CRON_SECRET authorization and drain execution.
 *
 * Run: npm test src/app/api/cron/drain-channels/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  _resetStoreForTesting,
} from "@/server/store/store";
import {
  callRoute,
  buildPostRequest,
  buildGetRequest,
  getCronDrainRoute,
  patchNextServerAfter,
  resetAfterCallbacks,
} from "@/test-utils/route-caller";

patchNextServerAfter();

// ---------------------------------------------------------------------------
// Environment isolation
// ---------------------------------------------------------------------------

async function withTestEnv(fn: () => Promise<void>): Promise<void> {
  const keys = [
    "NODE_ENV",
    "VERCEL",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
    "CRON_SECRET",
  ];
  const originals: Record<string, string | undefined> = {};

  for (const key of keys) {
    originals[key] = process.env[key];
  }

  (process.env as Record<string, string | undefined>)["NODE_ENV"] = "test";
  delete process.env.VERCEL;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;

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
  }
}

// ===========================================================================
// Authorization
// ===========================================================================

test("POST /api/cron/drain-channels: returns 401 with invalid CRON_SECRET", async () => {
  await withTestEnv(async () => {
    process.env.CRON_SECRET = "real-secret";

    const route = getCronDrainRoute();
    const request = buildPostRequest("/api/cron/drain-channels", "{}", {
      authorization: "Bearer wrong-secret",
    });
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 401);
    const body = result.json as { error: string };
    assert.equal(body.error, "UNAUTHORIZED");
  });
});

test("POST /api/cron/drain-channels: returns 401 with no auth when CRON_SECRET set", async () => {
  await withTestEnv(async () => {
    process.env.CRON_SECRET = "real-secret";

    const route = getCronDrainRoute();
    const request = buildPostRequest("/api/cron/drain-channels", "{}");
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 401);
  });
});

test("POST /api/cron/drain-channels: authorized with Bearer token", async () => {
  await withTestEnv(async () => {
    process.env.CRON_SECRET = "test-secret";

    const route = getCronDrainRoute();
    const request = buildPostRequest("/api/cron/drain-channels", "{}", {
      authorization: "Bearer test-secret",
    });
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 200);
    const body = result.json as { ok: boolean; results: Record<string, string> };
    assert.equal(body.ok, true);
    assert.equal(body.results.slack, "fulfilled");
    assert.equal(body.results.telegram, "fulfilled");
    assert.equal(body.results.discord, "fulfilled");
  });
});

test("POST /api/cron/drain-channels: authorized with x-cron-secret header", async () => {
  await withTestEnv(async () => {
    process.env.CRON_SECRET = "test-secret";

    const route = getCronDrainRoute();
    const request = buildPostRequest("/api/cron/drain-channels", "{}", {
      "x-cron-secret": "test-secret",
    });
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 200);
    const body = result.json as { ok: boolean };
    assert.equal(body.ok, true);
  });
});

test("GET /api/cron/drain-channels: also works via GET", async () => {
  await withTestEnv(async () => {
    process.env.CRON_SECRET = "test-secret";

    const route = getCronDrainRoute();
    const request = buildGetRequest("/api/cron/drain-channels", {
      authorization: "Bearer test-secret",
    });
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as { ok: boolean };
    assert.equal(body.ok, true);
  });
});

test("POST /api/cron/drain-channels: allows access without secret in non-production", async () => {
  await withTestEnv(async () => {
    delete process.env.CRON_SECRET;
    (process.env as Record<string, string | undefined>)["NODE_ENV"] = "test";

    const route = getCronDrainRoute();
    const request = buildPostRequest("/api/cron/drain-channels", "{}");
    const result = await callRoute(route.POST!, request);

    assert.equal(result.status, 200);
  });
});
