#!/usr/bin/env node

/**
 * Machine-readable remote deployment readiness gate.
 *
 * Fetches /api/admin/preflight from a deployed Vercel instance and validates
 * the launch contract: ok=true, storeBackend=upstash, aiGatewayAuth=oidc,
 * no failing checks, no failing channel connectability entries.
 *
 * Exit codes:
 *   0 — pass (deployment is channel-ready)
 *   1 — contract-fail (preflight returned data that violates the launch contract)
 *   2 — bad-args (missing or invalid CLI arguments)
 *   3 — fetch-fail (network error reaching the preflight endpoint)
 *   4 — bad-response (non-OK HTTP status or non-JSON response)
 *
 * Secrets:
 *   --protection-bypass flag or VERCEL_AUTOMATION_BYPASS_SECRET env var.
 *   Never passed as positional args, never logged unredacted.
 *
 * Usage:
 *   node scripts/check-deploy-readiness.mjs --base-url <url> [--json-only]
 *   VERCEL_AUTOMATION_BYPASS_SECRET="..." node scripts/check-deploy-readiness.mjs --base-url <url> --json-only
 */

import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "base-url": { type: "string" },
    "protection-bypass": { type: "string" },
    "timeout-ms": { type: "string", default: "15000" },
    "expect-store": { type: "string", default: "upstash" },
    "expect-ai-gateway-auth": { type: "string", default: "oidc" },
    "expect-ok": { type: "boolean", default: true },
    "json-only": { type: "boolean", default: false },
  },
});

const jsonOnly = values["json-only"];

function redactSecret(input, secret) {
  if (!secret) return input;
  return input.split(secret).join("[redacted]");
}

function log(message) {
  if (!jsonOnly) {
    process.stderr.write(`[check-deploy-readiness] ${message}\n`);
  }
}

function fail(code, message, details = {}) {
  const payload = { ok: false, code, message, ...details };
  const rendered = jsonOnly
    ? JSON.stringify(payload)
    : JSON.stringify(payload, null, 2);
  console.error(rendered);
  switch (code) {
    case "MISSING_BASE_URL":
    case "INVALID_TIMEOUT":
      process.exit(2);
      break;
    case "FETCH_FAILED":
      process.exit(3);
      break;
    case "INVALID_RESPONSE":
    case "BAD_STATUS":
      process.exit(4);
      break;
    default:
      process.exit(1);
  }
}

// --- Resolve inputs ---

const baseUrl =
  values["base-url"]?.trim() ||
  process.env.OPENCLAW_BASE_URL?.trim() ||
  "";

if (!baseUrl) {
  fail(
    "MISSING_BASE_URL",
    "Provide --base-url or set OPENCLAW_BASE_URL env var.",
  );
}

const timeoutMs = Number.parseInt(values["timeout-ms"], 10);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  fail("INVALID_TIMEOUT", "--timeout-ms must be a positive integer.");
}

const bypass =
  values["protection-bypass"]?.trim() ||
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() ||
  "";

// --- Build preflight URL ---

const preflightUrl = new URL("/api/admin/preflight", baseUrl);
if (bypass) {
  preflightUrl.searchParams.set("x-vercel-protection-bypass", bypass);
}

const redactedUrl = redactSecret(preflightUrl.toString(), bypass);
log(`fetching ${redactedUrl}`);

// --- Fetch preflight ---

let response;
try {
  response = await fetch(preflightUrl, {
    method: "GET",
    signal: AbortSignal.timeout(timeoutMs),
  });
} catch (error) {
  fail("FETCH_FAILED", "Failed to fetch /api/admin/preflight.", {
    url: redactedUrl,
    error: error instanceof Error ? error.message : String(error),
  });
}

log(`status=${response.status}`);

// --- Parse response ---

let payload;
try {
  payload = await response.json();
} catch (error) {
  fail("INVALID_RESPONSE", "Preflight did not return JSON.", {
    status: response.status,
    url: redactedUrl,
    error: error instanceof Error ? error.message : String(error),
  });
}

if (!response.ok || !payload || typeof payload !== "object") {
  fail("BAD_STATUS", "Preflight request failed.", {
    status: response.status,
    url: redactedUrl,
    payload,
  });
}

// --- Validate launch contract ---

const checks = Array.isArray(payload.checks) ? payload.checks : [];
const actions = Array.isArray(payload.actions) ? payload.actions : [];
const channels =
  payload.channels && typeof payload.channels === "object"
    ? payload.channels
    : {};

const failures = [];

if (values["expect-ok"] && payload.ok !== true) {
  failures.push("payload.ok !== true");
}
if (payload.storeBackend !== values["expect-store"]) {
  failures.push(
    `storeBackend=${payload.storeBackend ?? "null"}, expected=${values["expect-store"]}`,
  );
}
if (payload.aiGatewayAuth !== values["expect-ai-gateway-auth"]) {
  failures.push(
    `aiGatewayAuth=${payload.aiGatewayAuth ?? "null"}, expected=${values["expect-ai-gateway-auth"]}`,
  );
}
if (checks.some((check) => check && check.status === "fail")) {
  failures.push("checks contain fail");
}
if (
  Object.values(channels).some(
    (channel) =>
      channel &&
      typeof channel === "object" &&
      channel.status === "fail",
  )
) {
  failures.push("channels contain fail");
}

// --- Build result ---

const result = {
  ok: failures.length === 0,
  url: redactedUrl,
  status: response.status,
  summary: {
    ok: payload.ok ?? null,
    authMode: payload.authMode ?? null,
    publicOrigin: payload.publicOrigin ?? null,
    storeBackend: payload.storeBackend ?? null,
    aiGatewayAuth: payload.aiGatewayAuth ?? null,
    webhookBypassEnabled: payload.webhookBypassEnabled ?? null,
    cronSecretConfigured: payload.cronSecretConfigured ?? null,
  },
  failingChecks: checks.filter((check) => check && check.status === "fail"),
  requiredActions: actions.filter(
    (action) => action && action.status === "required",
  ),
  channelStatuses: Object.fromEntries(
    Object.entries(channels).map(([name, info]) => [
      name,
      info && typeof info === "object" ? info.status ?? null : null,
    ]),
  ),
  failures,
};

const rendered = jsonOnly
  ? JSON.stringify(result)
  : JSON.stringify(result, null, 2);

if (result.ok) {
  log("PASS — deployment is channel-ready");
  console.log(rendered);
  process.exit(0);
} else {
  log(`FAIL — ${failures.length} contract violation(s)`);
  console.error(rendered);
  process.exit(1);
}
