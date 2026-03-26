/**
 * Smoke tests for GET /api/channels/summary.
 *
 * Covers auth-gated channel summary with queue depth and failed counts.
 *
 * Run: npm test src/app/api/channels/summary/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  _resetStoreForTesting,
  mutateMeta,
} from "@/server/store/store";
import {
  callRoute,
  buildAuthGetRequest,
  buildGetRequest,
  getChannelsSummaryRoute,
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
  }
}

// ===========================================================================
// GET /api/channels/summary
// ===========================================================================

test("GET /api/channels/summary: returns summary for all channels including whatsapp", async () => {
  await withTestEnv(async () => {
    const route = getChannelsSummaryRoute();
    const request = buildAuthGetRequest("/api/channels/summary");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      slack: { connected: boolean; lastError: string | null };
      telegram: { connected: boolean; lastError: string | null };
      discord: { connected: boolean; lastError: string | null };
      whatsapp: {
        connected: boolean;
        lastError: string | null;
        deliveryMode: string;
        requiresRunningSandbox: boolean;
      };
    };

    // All channels disconnected by default
    assert.equal(body.slack.connected, false);
    assert.equal(body.telegram.connected, false);
    assert.equal(body.discord.connected, false);
    assert.equal(body.whatsapp.connected, false);
    assert.equal(body.whatsapp.deliveryMode, "gateway-native");
    assert.equal(body.whatsapp.requiresRunningSandbox, true);
  });
});

test("GET /api/channels/summary: reflects connected channel state", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.channels.slack = {
        signingSecret: "test-signing-secret",
        botToken: "xoxb-test",
        configuredAt: Date.now(),
        team: "Test Team",
        user: "U123",
        botId: "B123",
      };
    });

    const route = getChannelsSummaryRoute();
    const request = buildAuthGetRequest("/api/channels/summary");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      slack: { connected: boolean; lastError: string | null };
      telegram: { connected: boolean };
      discord: { connected: boolean };
    };

    assert.equal(body.slack.connected, true);
    assert.equal(body.slack.lastError, null);
    assert.equal(body.telegram.connected, false);
    assert.equal(body.discord.connected, false);
  });
});

test("GET /api/channels/summary: whatsapp connected reflects enabled config", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.channels.whatsapp = {
        enabled: true,
        configuredAt: Date.now(),
        lastKnownLinkState: "linked",
        linkedPhone: "+1234567890",
        dmPolicy: "pairing",
      };
    });

    const route = getChannelsSummaryRoute();
    const request = buildAuthGetRequest("/api/channels/summary");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      whatsapp: {
        connected: boolean;
        deliveryMode: string;
        requiresRunningSandbox: boolean;
        lastError: string | null;
      };
    };

    assert.equal(body.whatsapp.connected, true);
    assert.equal(body.whatsapp.deliveryMode, "gateway-native");
    assert.equal(body.whatsapp.requiresRunningSandbox, true);
    assert.equal(body.whatsapp.lastError, null);
  });
});

test("GET /api/channels/summary: whatsapp response has no webhookUrl field", async () => {
  await withTestEnv(async () => {
    const route = getChannelsSummaryRoute();
    const request = buildAuthGetRequest("/api/channels/summary");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as Record<string, Record<string, unknown>>;
    assert.equal(
      "webhookUrl" in body.whatsapp,
      false,
      "whatsapp summary must not contain webhookUrl",
    );
  });
});

test("GET /api/channels/summary: whatsapp disabled config returns connected false", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.channels.whatsapp = {
        enabled: false,
        configuredAt: Date.now(),
        lastKnownLinkState: "linked",
        linkedPhone: "+1234567890",
      };
    });

    const route = getChannelsSummaryRoute();
    const request = buildAuthGetRequest("/api/channels/summary");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      whatsapp: {
        connected: boolean;
        lastError: string | null;
        deliveryMode: string;
        requiresRunningSandbox: boolean;
      };
    };

    assert.equal(body.whatsapp.connected, false);
    assert.equal(body.whatsapp.lastError, null);
    assert.equal(body.whatsapp.deliveryMode, "gateway-native");
    assert.equal(body.whatsapp.requiresRunningSandbox, true);
  });
});

test("GET /api/channels/summary: whatsapp enabled but needs-login still reports connected in coarse summary", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.channels.whatsapp = {
        enabled: true,
        configuredAt: Date.now(),
        lastKnownLinkState: "needs-login",
        lastError: "scan QR to continue",
      };
    });

    const route = getChannelsSummaryRoute();
    const request = buildAuthGetRequest("/api/channels/summary");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      whatsapp: {
        connected: boolean;
        lastError: string | null;
      };
    };

    assert.equal(body.whatsapp.connected, true);
    assert.equal(body.whatsapp.lastError, "scan QR to continue");
  });
});

test("GET /api/channels/summary: whatsapp lastError is surfaced", async () => {
  await withTestEnv(async () => {
    await mutateMeta((meta) => {
      meta.channels.whatsapp = {
        enabled: true,
        configuredAt: Date.now(),
        lastKnownLinkState: "error",
        lastError: "connection timeout",
      };
    });

    const route = getChannelsSummaryRoute();
    const request = buildAuthGetRequest("/api/channels/summary");
    const result = await callRoute(route.GET!, request);

    assert.equal(result.status, 200);
    const body = result.json as {
      whatsapp: {
        connected: boolean;
        lastError: string | null;
      };
    };

    assert.equal(body.whatsapp.connected, true);
    assert.equal(body.whatsapp.lastError, "connection timeout");
  });
});

test("GET /api/channels/summary: works without CSRF headers when bearer token is present", async () => {
  await withTestEnv(async () => {
    const route = getChannelsSummaryRoute();
    const request = buildGetRequest("/api/channels/summary", {
      authorization: "Bearer test-admin-secret-for-scenarios",
    });
    const result = await callRoute(route.GET!, request);

    // Bearer token provides auth; CSRF headers not needed for GET
    assert.equal(result.status, 200);
  });
});
