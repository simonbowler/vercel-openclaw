import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  _setAiGatewayTokenOverrideForTesting,
  getAiGatewayAuthMode,
  isVercelDeployment,
  requiresDurableStore,
} from "@/server/env";

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

  try {
    return fn();
  } finally {
    for (const key of Object.keys(originals)) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
  }
}

// --- getAiGatewayAuthMode ---

afterEach(() => {
  _setAiGatewayTokenOverrideForTesting(null);
});

test("getAiGatewayAuthMode returns unavailable when no token source exists", async () => {
  await withEnv(
    { AI_GATEWAY_API_KEY: undefined },
    async () => {
      _setAiGatewayTokenOverrideForTesting(undefined);
      const mode = await getAiGatewayAuthMode();
      assert.equal(mode, "unavailable");
    },
  );
});

test("getAiGatewayAuthMode returns api-key when resolved token matches AI_GATEWAY_API_KEY", async () => {
  await withEnv(
    { AI_GATEWAY_API_KEY: "local-dev-key" },
    async () => {
      _setAiGatewayTokenOverrideForTesting("local-dev-key");
      const mode = await getAiGatewayAuthMode();
      assert.equal(mode, "api-key");
    },
  );
});

test("getAiGatewayAuthMode returns oidc when resolved token differs from AI_GATEWAY_API_KEY", async () => {
  await withEnv(
    { AI_GATEWAY_API_KEY: "local-dev-key" },
    async () => {
      _setAiGatewayTokenOverrideForTesting("oidc-runtime-token");
      const mode = await getAiGatewayAuthMode();
      assert.equal(mode, "oidc");
    },
  );
});

// --- isVercelDeployment ---

test("isVercelDeployment returns false with no Vercel markers", () => {
  withEnv(
    {
      VERCEL: undefined,
      VERCEL_ENV: undefined,
      VERCEL_URL: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
    },
    () => {
      assert.equal(isVercelDeployment(), false);
    },
  );
});

test("isVercelDeployment returns true when VERCEL_URL is set", () => {
  withEnv(
    {
      VERCEL: undefined,
      VERCEL_ENV: undefined,
      VERCEL_URL: "openclaw-example.vercel.app",
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
    },
    () => {
      assert.equal(isVercelDeployment(), true);
    },
  );
});

test("isVercelDeployment returns true when VERCEL is set", () => {
  withEnv(
    {
      VERCEL: "1",
      VERCEL_ENV: undefined,
      VERCEL_URL: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
    },
    () => {
      assert.equal(isVercelDeployment(), true);
    },
  );
});

// --- requiresDurableStore ---

test("requiresDurableStore returns false without Vercel markers", () => {
  withEnv(
    {
      VERCEL: undefined,
      VERCEL_ENV: undefined,
      VERCEL_URL: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      NODE_ENV: "production",
    },
    () => {
      assert.equal(requiresDurableStore(), false);
    },
  );
});

test("requiresDurableStore returns true on Vercel deployments", () => {
  withEnv(
    {
      VERCEL: "1",
      VERCEL_ENV: undefined,
      VERCEL_URL: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
    },
    () => {
      assert.equal(requiresDurableStore(), true);
    },
  );
});
