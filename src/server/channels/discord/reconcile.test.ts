import assert from "node:assert/strict";
import test from "node:test";

import { reconcileDiscordIntegration } from "@/server/channels/discord/reconcile";
import { withHarness } from "@/test-utils/harness";

test("reconcileDiscordIntegration patches endpoint and registers command", async () => {
  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.channels.discord = {
        publicKey: "pub-key",
        applicationId: "app-123",
        botToken: "bot-token",
        configuredAt: Date.now(),
        endpointConfigured: false,
        endpointUrl: "https://old.example.com/api/channels/discord/webhook",
        commandRegistered: false,
      };
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    h.fakeFetch.onGet(/discord\.com\/api\/v10\/applications\/@me/, () =>
      Response.json({
        id: "app-123",
        verify_key: "pub-key",
        name: "Test App",
        bot: { username: "test-bot" },
        interactions_endpoint_url:
          "https://old.example.com/api/channels/discord/webhook",
      }),
    );
    h.fakeFetch.onPatch(/discord\.com\/api\/v10\/applications\/@me/, () =>
      new Response(null, { status: 200 }),
    );
    h.fakeFetch.onPost(/discord\.com\/api\/v10\/applications\/app-123\/commands/, () =>
      Response.json({ id: "cmd-123", name: "ask" }),
    );

    try {
      const result = await reconcileDiscordIntegration({
        request: new Request("https://new.example.com/api/queues/channels/discord"),
        force: true,
      });

      assert.ok(result);
      assert.equal(result?.endpointPatched, true);
      assert.equal(result?.commandRegistered, true);
      assert.equal(
        result?.desiredUrl,
        "https://new.example.com/api/channels/discord/webhook",
      );

      const meta = await h.getMeta();
      assert.equal(
        meta.channels.discord?.endpointUrl,
        "https://new.example.com/api/channels/discord/webhook",
      );
      assert.equal(meta.channels.discord?.commandRegistered, true);
      assert.equal(meta.channels.discord?.commandId, "cmd-123");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("reconcileDiscordIntegration skips within throttle window", async () => {
  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.channels.discord = {
        publicKey: "pub-key",
        applicationId: "app-123",
        botToken: "bot-token",
        configuredAt: Date.now(),
      };
    });
    await h
      .getStore()
      .setValue("discord:integration:last-reconciled-at", Date.now());

    const result = await reconcileDiscordIntegration({
      request: new Request("https://new.example.com/api/queues/channels/discord"),
    });
    assert.equal(result, null);
  });
});
