import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  buildChannelConnectability,
  buildChannelConnectBlockedResponse,
} from "@/server/channels/connectability";
import { _setAiGatewayTokenOverrideForTesting } from "@/server/env";

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
