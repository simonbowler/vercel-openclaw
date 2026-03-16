import assert from "node:assert/strict";
import test from "node:test";

import { getPublicOrigin, getPublicOriginFromHint } from "./public-url";

function withEnv<T>(
  patch: Record<string, string | undefined>,
  fn: () => T,
): T {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(patch)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Contract: NEXT_PUBLIC_BASE_DOMAIN is the canonical origin when
// NEXT_PUBLIC_APP_URL is absent — even when the request arrives on a
// different host (e.g. a Vercel preview deployment).
// ---------------------------------------------------------------------------

test("[contract] getPublicOrigin prefers NEXT_PUBLIC_BASE_DOMAIN when NEXT_PUBLIC_APP_URL is unset", () => {
  withEnv(
    {
      NEXT_PUBLIC_APP_URL: undefined,
      NEXT_PUBLIC_BASE_DOMAIN: "app.example.com",
      BASE_DOMAIN: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      VERCEL_BRANCH_URL: undefined,
      VERCEL_URL: undefined,
    },
    () => {
      const request = new Request("https://preview-123.vercel.app/gateway", {
        headers: {
          "x-forwarded-host": "preview-123.vercel.app",
          "x-forwarded-proto": "https",
        },
      });

      assert.equal(getPublicOrigin(request), "https://app.example.com");
    },
  );
});

// ---------------------------------------------------------------------------
// Contract: getPublicOriginFromHint delegates to the same canonical rule
// so that background jobs and queue consumers resolve the same origin as
// request-based code paths.
// ---------------------------------------------------------------------------

test("[contract] getPublicOriginFromHint uses the same canonical rule as request-based resolution", () => {
  withEnv(
    {
      NEXT_PUBLIC_APP_URL: undefined,
      NEXT_PUBLIC_BASE_DOMAIN: "app.example.com",
      BASE_DOMAIN: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      VERCEL_BRANCH_URL: undefined,
      VERCEL_URL: undefined,
    },
    () => {
      assert.equal(
        getPublicOriginFromHint("https://preview-123.vercel.app"),
        "https://app.example.com",
      );
    },
  );
});

test("[contract] getPublicOriginFromHint with bare hostname hint", () => {
  withEnv(
    {
      NEXT_PUBLIC_APP_URL: undefined,
      NEXT_PUBLIC_BASE_DOMAIN: "app.example.com",
      BASE_DOMAIN: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      VERCEL_BRANCH_URL: undefined,
      VERCEL_URL: undefined,
    },
    () => {
      assert.equal(
        getPublicOriginFromHint("preview-123.vercel.app"),
        "https://app.example.com",
      );
    },
  );
});

test("[contract] getPublicOriginFromHint falls back to env when hint is empty", () => {
  withEnv(
    {
      NEXT_PUBLIC_APP_URL: undefined,
      NEXT_PUBLIC_BASE_DOMAIN: undefined,
      BASE_DOMAIN: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: "my-app.vercel.app",
      VERCEL_BRANCH_URL: undefined,
      VERCEL_URL: undefined,
    },
    () => {
      assert.equal(
        getPublicOriginFromHint(null),
        "https://my-app.vercel.app",
      );
      assert.equal(
        getPublicOriginFromHint(""),
        "https://my-app.vercel.app",
      );
      assert.equal(
        getPublicOriginFromHint(undefined),
        "https://my-app.vercel.app",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Contract: VERCEL_PROJECT_PRODUCTION_URL is the fallback when no
// configured domain and no request exist. This is the deployed-on-Vercel
// path for background jobs.
// ---------------------------------------------------------------------------

test("[contract] getPublicOrigin falls back to VERCEL_PROJECT_PRODUCTION_URL without request or configured domain", () => {
  withEnv(
    {
      NEXT_PUBLIC_APP_URL: undefined,
      NEXT_PUBLIC_BASE_DOMAIN: undefined,
      BASE_DOMAIN: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: "my-app.vercel.app",
      VERCEL_BRANCH_URL: undefined,
      VERCEL_URL: undefined,
    },
    () => {
      assert.equal(getPublicOrigin(), "https://my-app.vercel.app");
    },
  );
});
