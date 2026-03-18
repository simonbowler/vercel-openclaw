#!/usr/bin/env node

/**
 * Destructive restore benchmark harness.
 *
 * Runs repeated snapshot/stop → ensure?wait=1 cycles against a live
 * deployment and emits JSONL records plus summary statistics.
 *
 * Usage:
 *   node scripts/benchmark-restore.mjs --base-url https://my-app.vercel.app --cycles=3
 *   node scripts/benchmark-restore.mjs --base-url https://my-app.vercel.app --cycles=5 --vcpus=1,2,4
 *   node scripts/benchmark-restore.mjs --base-url https://my-app.vercel.app --cycles=5 --format=json
 *   node scripts/benchmark-restore.mjs --help
 *
 * Environment:
 *   SMOKE_AUTH_COOKIE — auth cookie for sign-in-with-vercel mode
 *   ADMIN_SECRET — admin bearer token (admin-secret mode)
 *
 * Exit codes:
 *   0 — all cycles completed
 *   1 — one or more cycles failed
 *   2 — bad arguments
 */

import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    "base-url": { type: "string" },
    cycles: { type: "string", default: "3" },
    vcpus: { type: "string", default: "" },
    format: { type: "string", default: "text" },
    "timeout-ms": { type: "string", default: "240000" },
    "request-timeout": { type: "string", default: "30" },
    variant: { type: "string", default: "baseline" },
    "json-only": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  process.stderr.write(`benchmark-restore — destructive restore benchmark harness

USAGE
  node scripts/benchmark-restore.mjs --base-url <url> [options]

OPTIONS
  --base-url        (required) Deployed app URL
  --cycles          Number of restore cycles per vCPU setting (default: 3)
  --vcpus           Comma-separated vCPU values to test (default: uses server default)
  --format          Output format: text | json (default: text)
  --timeout-ms      Wait timeout for ensure?wait=1 in ms (default: 240000)
  --request-timeout Per-request fetch timeout in seconds (default: 30)
  --variant         Label for this benchmark variant (default: baseline)
  --json-only       Suppress human-readable stderr output
  --help            Show this message

ENVIRONMENT
  SMOKE_AUTH_COOKIE  Auth cookie value
  ADMIN_SECRET       Admin bearer token

OUTPUT
  JSONL records to stdout: { cycle, vcpus, variant, restoreMetrics, totalWallMs, error? }
  Summary statistics at end (p50, p95 by phase grouped by vCPU)
`);
  process.exit(0);
}

const baseUrl = values["base-url"];
if (!baseUrl) {
  process.stderr.write("error: --base-url is required\n");
  process.exit(2);
}

const cycles = Number.parseInt(values.cycles, 10);
if (!Number.isFinite(cycles) || cycles < 1) {
  process.stderr.write("error: --cycles must be a positive integer\n");
  process.exit(2);
}

const vcpuList = values.vcpus
  ? values.vcpus.split(",").map((v) => Number.parseInt(v.trim(), 10))
  : [0]; // 0 means "use server default, don't override"

const format = values.format;
const timeoutMs = Number.parseInt(values["timeout-ms"], 10);
const requestTimeoutSec = Number.parseInt(values["request-timeout"], 10);
const variant = values.variant;
const jsonOnly = values["json-only"] || format === "json";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function buildHeaders() {
  const headers = {
    "content-type": "application/json",
    "x-requested-with": "XMLHttpRequest",
  };

  const cookie = process.env.SMOKE_AUTH_COOKIE;
  if (cookie) {
    headers.cookie = cookie;
    headers.origin = baseUrl;
  }

  const secret = process.env.ADMIN_SECRET;
  if (secret) {
    headers.authorization = `Bearer ${secret}`;
    headers.origin = baseUrl;
  }

  return headers;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) {
  if (!jsonOnly) {
    process.stderr.write(`[benchmark] ${msg}\n`);
  }
}

function emitJsonl(record) {
  process.stdout.write(JSON.stringify(record) + "\n");
}

async function apiPost(path, extraTimeoutMs) {
  const url = new URL(path, baseUrl).href;
  const timeout = (extraTimeoutMs ?? requestTimeoutSec * 1000) + 5000;
  const response = await fetch(url, {
    method: "POST",
    headers: buildHeaders(),
    signal: AbortSignal.timeout(timeout),
  });
  const body = await response.json();
  return { status: response.status, body };
}

// ---------------------------------------------------------------------------
// Benchmark cycle
// ---------------------------------------------------------------------------

async function runCycle(cycle, vcpus) {
  const wallStart = Date.now();
  const record = { cycle, vcpus: vcpus || "default", variant };

  try {
    // 1. Snapshot + stop
    log(`cycle=${cycle} vcpus=${vcpus || "default"} — stopping...`);
    const stopResult = await apiPost("/api/admin/stop");
    if (stopResult.status !== 200) {
      throw new Error(
        `stop failed: HTTP ${stopResult.status} ${JSON.stringify(stopResult.body)}`,
      );
    }
    log(`cycle=${cycle} — stopped, snapshotId=${stopResult.body.snapshotId ?? "?"}`);

    // 2. Restore via ensure?wait=1
    const ensurePath = `/api/admin/ensure?wait=1&timeoutMs=${timeoutMs}`;
    log(`cycle=${cycle} — ensuring (wait=1, timeout=${timeoutMs}ms)...`);
    const ensureResult = await apiPost(ensurePath, timeoutMs);

    if (ensureResult.status !== 200 || !ensureResult.body.restoreMetrics) {
      throw new Error(
        `ensure failed: HTTP ${ensureResult.status} ${JSON.stringify(ensureResult.body)}`,
      );
    }

    const metrics = ensureResult.body.restoreMetrics;
    const totalWallMs = Date.now() - wallStart;

    const result = {
      ...record,
      restoreMetrics: metrics,
      totalWallMs,
      ensureWaitedMs: ensureResult.body.waitedMs,
    };
    emitJsonl(result);
    log(
      `cycle=${cycle} — done totalMs=${metrics.totalMs} wallMs=${totalWallMs} ` +
        `create=${metrics.sandboxCreateMs} startup=${metrics.startupScriptMs} ` +
        `pair=${metrics.forcePairMs} fw=${metrics.firewallSyncMs} ` +
        `localReady=${metrics.localReadyMs} publicReady=${metrics.publicReadyMs}`,
    );
    return result;
  } catch (err) {
    const totalWallMs = Date.now() - wallStart;
    const errorRecord = {
      ...record,
      restoreMetrics: null,
      totalWallMs,
      error: err.message,
    };
    emitJsonl(errorRecord);
    log(`cycle=${cycle} — ERROR: ${err.message}`);
    return errorRecord;
  }
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function computeStats(results) {
  const PHASES = [
    "sandboxCreateMs",
    "tokenWriteMs",
    "assetSyncMs",
    "startupScriptMs",
    "forcePairMs",
    "firewallSyncMs",
    "localReadyMs",
    "publicReadyMs",
    "totalMs",
  ];

  const byVcpu = {};
  for (const r of results) {
    if (!r.restoreMetrics) continue;
    const key = String(r.vcpus);
    if (!byVcpu[key]) byVcpu[key] = [];
    byVcpu[key].push(r);
  }

  const summary = {};
  for (const [vcpuKey, records] of Object.entries(byVcpu)) {
    const phaseStats = {};
    for (const phase of PHASES) {
      const values = records
        .map((r) => r.restoreMetrics[phase])
        .filter((v) => typeof v === "number")
        .sort((a, b) => a - b);
      phaseStats[phase] = {
        count: values.length,
        min: values[0] ?? null,
        max: values[values.length - 1] ?? null,
        p50: percentile(values, 50),
        p95: percentile(values, 95),
        mean: values.length
          ? Math.round(values.reduce((a, b) => a + b, 0) / values.length)
          : null,
      };
    }
    summary[vcpuKey] = {
      vcpus: vcpuKey,
      cycles: records.length,
      phases: phaseStats,
    };
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`benchmark-restore starting: base-url=${baseUrl} cycles=${cycles} vcpus=${JSON.stringify(vcpuList)} variant=${variant}`);

  // Pre-check: make sure sandbox is running before starting cycles
  log("pre-check: ensuring sandbox is running...");
  const preCheck = await apiPost(`/api/admin/ensure?wait=1&timeoutMs=${timeoutMs}`, timeoutMs);
  if (preCheck.status !== 200) {
    process.stderr.write(
      `error: pre-check ensure failed: HTTP ${preCheck.status} ${JSON.stringify(preCheck.body)}\n`,
    );
    process.exit(1);
  }
  log(`pre-check: sandbox running, sandboxId=${preCheck.body.sandboxId}`);

  const allResults = [];
  let failures = 0;

  for (const vcpus of vcpuList) {
    // If we need to set vcpus, we'd need an env var override on the server.
    // For now, the --vcpus flag documents the setting used but doesn't change
    // the server config at runtime. The user sets OPENCLAW_SANDBOX_VCPUS
    // on the deployment between benchmark runs.
    if (vcpus !== 0 && vcpuList.length > 1) {
      log(`\n=== vCPU setting: ${vcpus} ===`);
      log(
        "NOTE: Set OPENCLAW_SANDBOX_VCPUS on the deployment to match. " +
          "This harness cannot change server env vars at runtime.",
      );
    }

    for (let i = 1; i <= cycles; i++) {
      const result = await runCycle(i, vcpus);
      allResults.push(result);
      if (result.error) failures++;
    }
  }

  // Summary
  const summary = computeStats(allResults);
  const report = {
    schemaVersion: 1,
    variant,
    baseUrl,
    cycles,
    vcpuList,
    totalResults: allResults.length,
    failures,
    summary,
  };

  if (format === "json") {
    // Final summary line
    emitJsonl({ type: "summary", ...report });
  } else {
    process.stderr.write("\n=== BENCHMARK SUMMARY ===\n");
    for (const [vcpuKey, stats] of Object.entries(summary)) {
      process.stderr.write(`\nvCPUs: ${vcpuKey} (${stats.cycles} cycles)\n`);
      process.stderr.write(
        "Phase                p50       p95       min       max       mean\n",
      );
      process.stderr.write(
        "─────────────────────────────────────────────────────────────────\n",
      );
      for (const [phase, s] of Object.entries(stats.phases)) {
        const pad = (v) => String(v ?? "—").padStart(8);
        process.stderr.write(
          `${phase.padEnd(20)} ${pad(s.p50)}  ${pad(s.p95)}  ${pad(s.min)}  ${pad(s.max)}  ${pad(s.mean)}\n`,
        );
      }
    }
    process.stderr.write(`\nTotal results: ${allResults.length}, failures: ${failures}\n`);
    // Also emit the summary as JSON to stdout
    emitJsonl({ type: "summary", ...report });
  }

  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
