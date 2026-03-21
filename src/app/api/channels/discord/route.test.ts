import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  buildChannelConnectability,
  buildChannelConnectBlockedResponse,
} from "@/server/channels/connectability";
import { _setAiGatewayTokenOverrideForTesting } from "@/server/env";
import { withHarness } from "@/test-utils/harness";
import {
  buildAuthGetRequest,
  buildAuthPutRequest,
  callRoute,
  getDiscordChannelRoute,
} from "@/test-utils/route-caller";

afterEach(() => {
  _setAiGatewayTokenOverrideForTesting(null);
});

test("discord PUT returns 409 on localhost origin", async () => {
  _setAiGatewayTokenOverrideForTesting("oidc-token");
  const request = new Request("http://localhost:3000/api/channels/discord", {
    method: "PUT",
    headers: {
      host: "localhost:3000",
      "x-forwarded-host": "localhost:3000",
      "x-forwarded-proto": "http",
    },
  });

  const connectability = await buildChannelConnectability("discord", request);
  assert.equal(connectability.canConnect, false);
  assert.equal(connectability.channel, "discord");
  assert.ok(connectability.issues.some((i) => i.status === "fail"));

  const response = buildChannelConnectBlockedResponse(
    { setCookieHeader: null },
    connectability,
  );

  assert.equal(response.status, 409);
});

test("discord 409 response body matches expected shape", async () => {
  _setAiGatewayTokenOverrideForTesting("oidc-token");
  const request = new Request("http://localhost:3000/api/channels/discord", {
    method: "PUT",
    headers: {
      host: "localhost:3000",
      "x-forwarded-host": "localhost:3000",
      "x-forwarded-proto": "http",
    },
  });

  const connectability = await buildChannelConnectability("discord", request);
  const response = buildChannelConnectBlockedResponse(
    { setCookieHeader: null },
    connectability,
  );

  const payload = (await response.json()) as {
    error: { code: string; message: string };
    connectability: { channel: string; canConnect: boolean; issues: { id: string }[] };
  };

  assert.equal(payload.error.code, "CHANNEL_CONNECT_BLOCKED");
  assert.equal(payload.connectability.channel, "discord");
  assert.equal(payload.connectability.canConnect, false);
  assert.ok(payload.connectability.issues.length > 0);
});

// ---------------------------------------------------------------------------
// Route-level regression: PUT through the route factory returns 409
// ---------------------------------------------------------------------------

test("discord PUT through route factory returns 409 when not connectable", async () => {
  await withHarness(async () => {
    _setAiGatewayTokenOverrideForTesting("oidc-token");

    const route = getDiscordChannelRoute();
    const request = buildAuthPutRequest(
      "/api/channels/discord",
      JSON.stringify({ applicationId: "a", publicKey: "p", botToken: "t" }),
    );

    const result = await callRoute(route.PUT!, request);

    assert.equal(result.status, 409);
    const body = result.json as {
      error: { code: string; message: string };
      connectability: { channel: string; canConnect: boolean };
    };
    assert.equal(body.error.code, "CHANNEL_CONNECT_BLOCKED");
    assert.equal(body.connectability.channel, "discord");
    assert.equal(body.connectability.canConnect, false);
  });
});


// ---------------------------------------------------------------------------
// Existing: discord GET diagnostics
// ---------------------------------------------------------------------------

test("discord GET diagnostics reports endpoint drift", async () => {
  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.channels.discord = {
        publicKey: "pub-key",
        applicationId: "app-123",
        botToken: "bot-token",
        configuredAt: Date.now(),
        endpointConfigured: true,
        endpointUrl: "https://old.example.com/api/channels/discord/webhook",
        commandRegistered: true,
        commandId: "cmd-123",
      };
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    h.fakeFetch.onGet(/discord\.com\/api\/v10\/applications\/@me/, () =>
      Response.json({
        id: "app-123",
        verify_key: "pub-key",
        interactions_endpoint_url:
          "https://old.example.com/api/channels/discord/webhook",
      }),
    );

    try {
      const route = getDiscordChannelRoute();
      const request = buildAuthGetRequest("/api/channels/discord?diagnostics=1", {
        host: "new.example.com",
        "x-forwarded-host": "new.example.com",
        "x-forwarded-proto": "https",
      });
      const result = await callRoute(route.GET!, request);

      assert.equal(result.status, 200);
      const body = result.json as {
        diagnostics?: {
          currentEndpointUrl: string | null;
          desiredEndpointUrl: string;
          endpointDrift: boolean;
        };
      };
      assert.equal(
        body.diagnostics?.currentEndpointUrl,
        "https://old.example.com/api/channels/discord/webhook",
      );
      assert.equal(
        body.diagnostics?.desiredEndpointUrl,
        "https://new.example.com/api/channels/discord/webhook",
      );
      assert.equal(body.diagnostics?.endpointDrift, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
