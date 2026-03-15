/**
 * Tests for POST /api/channels/discord/register-command.
 *
 * Covers: auth enforcement (403 without CSRF), Discord not configured (409),
 * happy path with mocked Discord API, and Discord API error handling.
 *
 * Run: npm test src/app/api/channels/discord/register-command/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { withHarness } from "@/test-utils/harness";
import {
  callRoute,
  buildPostRequest,
  buildAuthPostRequest,
  getDiscordRegisterCommandRoute,
} from "@/test-utils/route-caller";

// ===========================================================================
// Auth enforcement
// ===========================================================================

test("Discord register-command: POST without CSRF headers returns 403", async () => {
  await withHarness(async () => {
    const route = getDiscordRegisterCommandRoute();
    const req = buildPostRequest(
      "/api/channels/discord/register-command",
      "{}",
    );
    const result = await callRoute(route.POST!, req);
    assert.equal(result.status, 403);
  });
});

// ===========================================================================
// Discord not configured
// ===========================================================================

test("Discord register-command: no Discord config returns 409", async () => {
  await withHarness(async () => {
    const route = getDiscordRegisterCommandRoute();
    const req = buildAuthPostRequest(
      "/api/channels/discord/register-command",
      "{}",
    );
    const result = await callRoute(route.POST!, req);
    assert.equal(result.status, 409);
  });
});

// ===========================================================================
// Happy path (mocked fetch)
// ===========================================================================

test("Discord register-command: registers command and returns commandId", async () => {
  await withHarness(async (h) => {
    h.configureAllChannels();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    h.fakeFetch.onPost(/discord\.com\/api\/v10\/applications\/.*\/commands/, () =>
      Response.json({ id: "cmd-123456", name: "ask" }),
    );

    try {
      const route = getDiscordRegisterCommandRoute();
      const req = buildAuthPostRequest(
        "/api/channels/discord/register-command",
        "{}",
      );
      const result = await callRoute(route.POST!, req);

      assert.equal(result.status, 200);
      const body = result.json as { ok: boolean; commandId: string };
      assert.equal(body.ok, true);
      assert.equal(body.commandId, "cmd-123456");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ===========================================================================
// Discord API error
// ===========================================================================

test("Discord register-command: Discord API failure returns error", async () => {
  await withHarness(async (h) => {
    h.configureAllChannels();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    h.fakeFetch.onPost(/discord\.com\/api\/v10\/applications\/.*\/commands/, () =>
      new Response("Forbidden", { status: 403 }),
    );

    try {
      const route = getDiscordRegisterCommandRoute();
      const req = buildAuthPostRequest(
        "/api/channels/discord/register-command",
        "{}",
      );
      const result = await callRoute(route.POST!, req);
      assert.ok(result.status >= 400);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
