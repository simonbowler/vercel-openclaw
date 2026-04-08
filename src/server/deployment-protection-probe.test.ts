import assert from "node:assert/strict";
import { afterEach, test, mock } from "node:test";

import {
  probeDeploymentProtection,
  _resetProbeForTesting,
} from "@/server/deployment-protection-probe";

const ORIGINAL_ENV = { ...process.env };

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

afterEach(() => {
  resetEnv();
  _resetProbeForTesting();
  mock.restoreAll();
});

test("probe returns skipped when not on Vercel", async () => {
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;

  const result = await probeDeploymentProtection();
  assert.equal(result.status, "skipped");
  assert.equal(result.probeError, null);
});

test("probe returns skipped when no public origin can be resolved", async () => {
  process.env.VERCEL = "1";
  // No origin env vars set, no request
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.NEXT_PUBLIC_BASE_DOMAIN;
  delete process.env.BASE_DOMAIN;
  delete process.env.VERCEL_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.VERCEL_BRANCH_URL;

  const result = await probeDeploymentProtection();
  assert.equal(result.status, "skipped");
});

test("probe detects Vercel SSO redirect (302 to vercel.com)", async () => {
  process.env.VERCEL = "1";
  process.env.VERCEL_URL = "my-app.vercel.app";

  const mockFetch = mock.fn(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://vercel.com/sso-login/my-app" },
      }),
  );
  mock.method(globalThis, "fetch", mockFetch);

  const result = await probeDeploymentProtection();
  assert.equal(result.status, "detected");
  assert.equal(result.probeError, null);
});

test("probe detects 401 as deployment protection", async () => {
  process.env.VERCEL = "1";
  process.env.VERCEL_URL = "my-app.vercel.app";

  const mockFetch = mock.fn(
    async () =>
      new Response("<html>Vercel SSO Login</html>", { status: 401 }),
  );
  mock.method(globalThis, "fetch", mockFetch);

  const result = await probeDeploymentProtection();
  assert.equal(result.status, "detected");
});

test("probe returns clear on 200", async () => {
  process.env.VERCEL = "1";
  process.env.VERCEL_URL = "my-app.vercel.app";

  const mockFetch = mock.fn(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  mock.method(globalThis, "fetch", mockFetch);

  const result = await probeDeploymentProtection();
  assert.equal(result.status, "clear");
  assert.equal(result.probeError, null);
});

test("probe returns indeterminate on unexpected status", async () => {
  process.env.VERCEL = "1";
  process.env.VERCEL_URL = "my-app.vercel.app";

  const mockFetch = mock.fn(
    async () => new Response(null, { status: 500 }),
  );
  mock.method(globalThis, "fetch", mockFetch);

  const result = await probeDeploymentProtection();
  assert.equal(result.status, "indeterminate");
  assert.ok(result.probeError?.includes("500"));
});

test("probe returns indeterminate on network error", async () => {
  process.env.VERCEL = "1";
  process.env.VERCEL_URL = "my-app.vercel.app";

  const mockFetch = mock.fn(async () => {
    throw new Error("fetch failed");
  });
  mock.method(globalThis, "fetch", mockFetch);

  const result = await probeDeploymentProtection();
  assert.equal(result.status, "indeterminate");
  assert.ok(result.probeError?.includes("fetch failed"));
});

test("probe includes bypass secret when configured", async () => {
  process.env.VERCEL = "1";
  process.env.VERCEL_URL = "my-app.vercel.app";
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "my-secret";

  let capturedUrl = "";
  const mockFetch = mock.fn(async (url: string) => {
    capturedUrl = url;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  mock.method(globalThis, "fetch", mockFetch);

  const result = await probeDeploymentProtection();
  assert.equal(result.status, "clear");
  assert.ok(
    capturedUrl.includes("x-vercel-protection-bypass=my-secret"),
    `Expected bypass in URL, got: ${capturedUrl}`,
  );
});

test("probe caches result across calls", async () => {
  process.env.VERCEL = "1";
  process.env.VERCEL_URL = "my-app.vercel.app";

  let callCount = 0;
  const mockFetch = mock.fn(async () => {
    callCount++;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  mock.method(globalThis, "fetch", mockFetch);

  const first = await probeDeploymentProtection();
  const second = await probeDeploymentProtection();

  assert.equal(first.status, "clear");
  assert.deepStrictEqual(first, second);
  assert.equal(callCount, 1, "fetch should be called only once");
});

test("probe detects stale bypass secret (401 even with bypass)", async () => {
  process.env.VERCEL = "1";
  process.env.VERCEL_URL = "my-app.vercel.app";
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "stale-secret";

  const mockFetch = mock.fn(
    async () =>
      new Response("<html>Vercel SSO Login</html>", { status: 401 }),
  );
  mock.method(globalThis, "fetch", mockFetch);

  const result = await probeDeploymentProtection();
  assert.equal(result.status, "detected");
});
