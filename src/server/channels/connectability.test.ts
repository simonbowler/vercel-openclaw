import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { buildChannelConnectability } from "@/server/channels/connectability";
import { _setAiGatewayTokenOverrideForTesting } from "@/server/env";

const ORIGINAL_ENV = { ...process.env };
const LOCAL_ORIGIN = "http://localhost:3000";
const PUBLIC_ORIGIN = "https://openclaw.example";

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function makeRequest(origin: string): Request {
  const host = origin.replace(/^https?:\/\//, "");
  return new Request(`${origin}/api/status`, {
    headers: {
      host,
      "x-forwarded-host": host,
      "x-forwarded-proto": origin.startsWith("https://") ? "https" : "http",
    },
  });
}

afterEach(() => {
  resetEnv();
  _setAiGatewayTokenOverrideForTesting(null);
});

test("fails when the webhook url is not public https", async () => {
  _setAiGatewayTokenOverrideForTesting("oidc-token");
  const result = await buildChannelConnectability(
    "discord",
    makeRequest(LOCAL_ORIGIN),
  );

  assert.equal(result.canConnect, false);
  assert.equal(result.status, "fail");
  const issue = result.issues.find((i) => i.id === "public-webhook-url");
  assert.ok(issue, "expected public-webhook-url issue");
  assert.equal(typeof issue.remediation, "string");
  assert.ok(issue.remediation.length > 0, "remediation should not be empty");
});

test("fails when deployment protection is active on Vercel without bypass secret", async () => {
  process.env.VERCEL = "1";
  process.env.VERCEL_AUTH_MODE = "deployment-protection";
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  _setAiGatewayTokenOverrideForTesting("oidc-token");

  const result = await buildChannelConnectability(
    "telegram",
    makeRequest(PUBLIC_ORIGIN),
  );

  assert.equal(result.canConnect, false);
  const issue = result.issues.find((i) => i.id === "webhook-bypass");
  assert.ok(issue, "expected webhook-bypass issue");
  assert.equal(typeof issue.remediation, "string");
  assert.ok(
    issue.remediation.includes("Deployment Protection"),
    "remediation should mention Deployment Protection",
  );
});

test("passes with public origin, bypass, durable store, and OIDC", async () => {
  process.env.VERCEL = "1";
  process.env.VERCEL_AUTH_MODE = "deployment-protection";
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass";
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  delete process.env.AI_GATEWAY_API_KEY;
  _setAiGatewayTokenOverrideForTesting("oidc-token");

  const result = await buildChannelConnectability(
    "slack",
    makeRequest(PUBLIC_ORIGIN),
  );

  assert.equal(result.canConnect, true);
  assert.equal(result.status, "pass");
  assert.equal(result.issues.length, 0);
});

test("does not warn about missing CRON_SECRET", async () => {
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  delete process.env.CRON_SECRET;
  _setAiGatewayTokenOverrideForTesting("oidc-token");

  const result = await buildChannelConnectability(
    "slack",
    makeRequest(PUBLIC_ORIGIN),
  );

  const issueIds = result.issues.map((issue) => issue.id);
  assert.equal(
    issueIds.includes("drain-recovery" as never),
    false,
    "connectability should not include drain-recovery warning",
  );
});

test("fails when Upstash env vars are missing", async () => {
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  _setAiGatewayTokenOverrideForTesting("oidc-token");

  const result = await buildChannelConnectability(
    "slack",
    makeRequest(PUBLIC_ORIGIN),
  );

  assert.equal(result.canConnect, false);
  const issue = result.issues.find((i) => i.id === "store");
  assert.ok(issue, "expected store issue");
  assert.equal(issue.status, "fail");
});

test("fails with multiple issues when bypass, store, and OIDC are all missing on Vercel", async () => {
  process.env.VERCEL = "1";
  process.env.VERCEL_AUTH_MODE = "deployment-protection";
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.AI_GATEWAY_API_KEY;
  _setAiGatewayTokenOverrideForTesting(undefined);

  const result = await buildChannelConnectability(
    "slack",
    makeRequest(PUBLIC_ORIGIN),
  );

  assert.equal(result.canConnect, false);
  assert.equal(result.status, "fail");
  const issueIds = result.issues.map((i) => i.id).sort();
  assert.deepEqual(issueIds, ["ai-gateway", "store", "webhook-bypass"]);
  assert.equal(
    result.webhookUrl,
    `${PUBLIC_ORIGIN}/api/channels/slack/webhook`,
  );
});

test("webhook URL includes bypass query param when bypass secret is set", async () => {
  process.env.VERCEL = "1";
  process.env.VERCEL_AUTH_MODE = "deployment-protection";
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass-secret";
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  delete process.env.AI_GATEWAY_API_KEY;
  _setAiGatewayTokenOverrideForTesting("oidc-token");

  const result = await buildChannelConnectability(
    "telegram",
    makeRequest(PUBLIC_ORIGIN),
  );

  assert.equal(result.canConnect, true);
  assert.ok(result.webhookUrl);
  const webhookUrl = new URL(result.webhookUrl!);
  assert.equal(webhookUrl.hostname, "openclaw.example");
  assert.equal(webhookUrl.pathname, "/api/channels/telegram/webhook");
  assert.equal(
    webhookUrl.searchParams.get("x-vercel-protection-bypass"),
    "bypass-secret",
  );
});

test("fails when isVercelDeployment() and auth is not oidc", async () => {
  process.env.VERCEL = "1";
  process.env.NEXT_PUBLIC_APP_URL = PUBLIC_ORIGIN;
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  process.env.AI_GATEWAY_API_KEY = "static-key";
  _setAiGatewayTokenOverrideForTesting("static-key");

  const result = await buildChannelConnectability(
    "telegram",
    makeRequest(PUBLIC_ORIGIN),
  );

  assert.equal(result.canConnect, false);
  const issue = result.issues.find((i) => i.id === "ai-gateway");
  assert.ok(issue, "expected ai-gateway issue");
  assert.equal(issue.status, "fail");
});
