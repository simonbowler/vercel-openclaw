import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  buildChannelConnectability,
  buildChannelConnectBlockedResponse,
} from "@/server/channels/connectability";
import { _setAiGatewayTokenOverrideForTesting } from "@/server/env";
import { withHarness } from "@/test-utils/harness";
import {
  buildAuthPutRequest,
  callRoute,
  getTelegramChannelRoute,
} from "@/test-utils/route-caller";

afterEach(() => {
  _setAiGatewayTokenOverrideForTesting(null);
});

test("telegram PUT returns 409 on localhost origin", async () => {
  _setAiGatewayTokenOverrideForTesting("oidc-token");
  const request = new Request("http://localhost:3000/api/channels/telegram", {
    method: "PUT",
    headers: {
      host: "localhost:3000",
      "x-forwarded-host": "localhost:3000",
      "x-forwarded-proto": "http",
    },
  });

  const connectability = await buildChannelConnectability("telegram", request);
  assert.equal(connectability.canConnect, false);
  assert.equal(connectability.channel, "telegram");
  assert.ok(connectability.issues.some((i) => i.status === "fail"));

  const response = buildChannelConnectBlockedResponse(
    { setCookieHeader: null },
    connectability,
  );

  assert.equal(response.status, 409);
});

test("telegram 409 response body matches expected shape", async () => {
  _setAiGatewayTokenOverrideForTesting("oidc-token");
  const request = new Request("http://localhost:3000/api/channels/telegram", {
    method: "PUT",
    headers: {
      host: "localhost:3000",
      "x-forwarded-host": "localhost:3000",
      "x-forwarded-proto": "http",
    },
  });

  const connectability = await buildChannelConnectability("telegram", request);
  const response = buildChannelConnectBlockedResponse(
    { setCookieHeader: null },
    connectability,
  );

  const payload = (await response.json()) as {
    error: { code: string; message: string };
    connectability: { channel: string; canConnect: boolean; issues: { id: string }[] };
  };

  assert.equal(payload.error.code, "CHANNEL_CONNECT_BLOCKED");
  assert.equal(payload.connectability.channel, "telegram");
  assert.equal(payload.connectability.canConnect, false);
  assert.ok(payload.connectability.issues.length > 0);
});

// ---------------------------------------------------------------------------
// Route-level regression: PUT through the route factory returns 409
// ---------------------------------------------------------------------------

test("telegram PUT through route factory returns 409 when not connectable", async () => {
  await withHarness(async () => {
    _setAiGatewayTokenOverrideForTesting("oidc-token");

    const route = getTelegramChannelRoute();
    const request = buildAuthPutRequest(
      "/api/channels/telegram",
      JSON.stringify({ botToken: "123:abc" }),
    );

    const result = await callRoute(route.PUT!, request);

    assert.equal(result.status, 409);
    const body = result.json as {
      error: { code: string; message: string };
      connectability: { channel: string; canConnect: boolean };
    };
    assert.equal(body.error.code, "CHANNEL_CONNECT_BLOCKED");
    assert.equal(body.connectability.channel, "telegram");
    assert.equal(body.connectability.canConnect, false);
  });
});

