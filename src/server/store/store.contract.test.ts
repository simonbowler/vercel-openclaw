import assert from "node:assert/strict";
import test from "node:test";

import { _resetStoreForTesting, getStore } from "./store";

function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    originals[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }

  const restore = () => {
    for (const key of Object.keys(originals)) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
    _resetStoreForTesting();
  };

  let result: T | Promise<T>;
  try {
    result = fn();
  } catch (err) {
    restore();
    throw err;
  }

  if (result instanceof Promise) {
    return result.finally(restore);
  }

  restore();
  return result;
}

// ---------------------------------------------------------------------------
// Contract: memory store is allowed outside Vercel even in production mode.
// This is the self-hosted / non-Vercel deployment path. The store policy
// must match what preflight reports (warn, not fail).
// ---------------------------------------------------------------------------

test("[contract] memory store allowed outside Vercel even in production mode", () => {
  withEnv(
    {
      NODE_ENV: "production",
      VERCEL: undefined,
      VERCEL_ENV: undefined,
      VERCEL_URL: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      UPSTASH_REDIS_REST_URL: undefined,
      UPSTASH_REDIS_REST_TOKEN: undefined,
      KV_REST_API_URL: undefined,
      KV_REST_API_TOKEN: undefined,
    },
    () => {
      _resetStoreForTesting();
      assert.equal(getStore().name, "memory");
      _resetStoreForTesting();
    },
  );
});

// ---------------------------------------------------------------------------
// Contract: getStore() throws on Vercel without Upstash.
// This ensures runtime behavior matches preflight's hard fail for missing
// durable store on Vercel deployments.
// ---------------------------------------------------------------------------

test("[contract] getStore() throws on Vercel without Upstash", () => {
  withEnv(
    {
      NODE_ENV: "production",
      VERCEL: "1",
      VERCEL_ENV: "production",
      VERCEL_URL: "preview-123.vercel.app",
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      UPSTASH_REDIS_REST_URL: undefined,
      UPSTASH_REDIS_REST_TOKEN: undefined,
      KV_REST_API_URL: undefined,
      KV_REST_API_TOKEN: undefined,
    },
    () => {
      _resetStoreForTesting();
      assert.throws(
        () => getStore(),
        /Upstash Redis is required on Vercel deployments/,
      );
      _resetStoreForTesting();
    },
  );
});

// ---------------------------------------------------------------------------
// Contract: any single Vercel marker triggers durable-store requirement.
// Covers VERCEL_ENV alone (without VERCEL=1), which can happen on preview
// deployments.
// ---------------------------------------------------------------------------

test("[contract] getStore() throws when only VERCEL_ENV is set (no VERCEL=1)", () => {
  withEnv(
    {
      NODE_ENV: "production",
      VERCEL: undefined,
      VERCEL_ENV: "preview",
      VERCEL_URL: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      UPSTASH_REDIS_REST_URL: undefined,
      UPSTASH_REDIS_REST_TOKEN: undefined,
      KV_REST_API_URL: undefined,
      KV_REST_API_TOKEN: undefined,
    },
    () => {
      _resetStoreForTesting();
      assert.throws(
        () => getStore(),
        /Upstash Redis is required on Vercel deployments/,
      );
      _resetStoreForTesting();
    },
  );
});

// ---------------------------------------------------------------------------
// Contract: VERCEL_PROJECT_PRODUCTION_URL alone triggers durable-store
// requirement. This is the path where a production URL is set but VERCEL=1
// is absent.
// ---------------------------------------------------------------------------

test("[contract] getStore() throws when only VERCEL_PROJECT_PRODUCTION_URL is set", () => {
  withEnv(
    {
      NODE_ENV: "development",
      VERCEL: undefined,
      VERCEL_ENV: undefined,
      VERCEL_URL: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: "my-app.vercel.app",
      UPSTASH_REDIS_REST_URL: undefined,
      UPSTASH_REDIS_REST_TOKEN: undefined,
      KV_REST_API_URL: undefined,
      KV_REST_API_TOKEN: undefined,
    },
    () => {
      _resetStoreForTesting();
      assert.throws(
        () => getStore(),
        /Upstash Redis is required on Vercel deployments/,
      );
      _resetStoreForTesting();
    },
  );
});
