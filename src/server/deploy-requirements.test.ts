import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  getWebhookBypassRequirement,
  getWebhookBypassStatusMessage,
} from "@/server/deploy-requirements";

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
});

test("bypass is not required in sign-in-with-vercel mode", () => {
  process.env.VERCEL_AUTH_MODE = "sign-in-with-vercel";
  delete process.env.VERCEL;
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  const requirement = getWebhookBypassRequirement();
  assert.deepEqual(requirement, {
    required: false,
    configured: false,
    reason: "sign-in-with-vercel",
  });
  assert.equal(
    getWebhookBypassStatusMessage(requirement),
    "Webhook bypass is not required in sign-in-with-vercel mode.",
  );
});

test("bypass is not required off Vercel even in deployment-protection mode", () => {
  process.env.VERCEL_AUTH_MODE = "deployment-protection";
  delete process.env.VERCEL;
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  const requirement = getWebhookBypassRequirement();
  assert.deepEqual(requirement, {
    required: false,
    configured: false,
    reason: "local-or-non-vercel",
  });
  assert.equal(
    getWebhookBypassStatusMessage(requirement),
    "Webhook bypass is only required for protected Vercel deployments.",
  );
});

test("bypass is required on protected Vercel deployments", () => {
  process.env.VERCEL_AUTH_MODE = "deployment-protection";
  process.env.VERCEL = "1";
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  const requirement = getWebhookBypassRequirement();
  assert.deepEqual(requirement, {
    required: true,
    configured: false,
    reason: "protected-vercel",
  });
  assert.equal(
    getWebhookBypassStatusMessage(requirement),
    "Deployment Protection is enabled on Vercel but VERCEL_AUTOMATION_BYPASS_SECRET is missing. Slack, Telegram, and Discord webhooks will be blocked.",
  );
});

test("bypass is required and configured when secret is present", () => {
  process.env.VERCEL_AUTH_MODE = "deployment-protection";
  process.env.VERCEL = "1";
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "secret";

  const requirement = getWebhookBypassRequirement();
  assert.deepEqual(requirement, {
    required: true,
    configured: true,
    reason: "protected-vercel",
  });
  assert.equal(
    getWebhookBypassStatusMessage(requirement),
    "Webhook URLs will include x-vercel-protection-bypass.",
  );
});
