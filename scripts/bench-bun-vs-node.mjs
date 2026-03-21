#!/usr/bin/env node

/**
 * A/B benchmark: Bun vs Node gateway boot on snapshot restore.
 *
 * Creates two snapshots — one with Bun installed, one without — then runs
 * restore cycles for each, measuring restore + gateway boot time.
 *
 * Usage:
 *   node scripts/bench-bun-vs-node.mjs --cycles=3
 *   node scripts/bench-bun-vs-node.mjs --cycles=5 --vcpus=2
 */

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  try {
    const envPath = resolve(__dirname, "../.env.local");
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq);
      let val = trimmed.slice(eq + 1);
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    process.stderr.write(
      `failed to load .env.local: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}
loadEnv();

const { values } = parseArgs({
  options: {
    cycles: { type: "string", default: "3" },
    vcpus: { type: "string", default: "1" },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  process.stderr.write(`bench-bun-vs-node — A/B benchmark for gateway boot runtime

USAGE
  node scripts/bench-bun-vs-node.mjs [options]

OPTIONS
  --cycles   Restore cycles per variant (default: 3)
  --vcpus    vCPU count (default: 1)
  --help     Show this message
`);
  process.exit(0);
}

const CYCLES = Number(values.cycles);
const VCPUS = Number(values.vcpus);
const TIMEOUT_MS = 300_000;
const PACKAGE_SPEC = process.env.OPENCLAW_PACKAGE_SPEC || "openclaw@latest";

const PATHS = {
  OPENCLAW_BIN: "/home/vercel-sandbox/.global/npm/bin/openclaw",
  OPENCLAW_STATE_DIR: "/home/vercel-sandbox/.openclaw",
  OPENCLAW_CONFIG_PATH: "/home/vercel-sandbox/.openclaw/openclaw.json",
  OPENCLAW_GATEWAY_TOKEN_PATH: "/home/vercel-sandbox/.openclaw/.gateway-token",
  OPENCLAW_AI_GATEWAY_API_KEY_PATH: "/home/vercel-sandbox/.openclaw/.ai-gateway-api-key",
  OPENCLAW_FAST_RESTORE_SCRIPT_PATH: "/home/vercel-sandbox/.openclaw/.fast-restore.sh",
  OPENCLAW_LOG_FILE: "/tmp/openclaw.log",
  BUN_BIN: "/home/vercel-sandbox/.bun/bin/bun",
};

// Bun install constants — match src/server/openclaw/config.ts
const BUN_VERSION = "1.3.11";
const BUN_DOWNLOAD_URL = `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip`;
const BUN_DOWNLOAD_SHA256 = "8611ba935af886f05a6f38740a15160326c15e5d5d07adef966130b4493607ed";
const BUN_INSTALL_DIR = "/home/vercel-sandbox/.bun";

function log(msg) {
  process.stderr.write(`${msg}\n`);
}

const { Sandbox } = await import("@vercel/sandbox");

// Build a fast-restore script that uses the specified runtime
function buildFastRestoreScript(runtime) {
  const gatewayCmd = runtime === "bun"
    ? `${PATHS.BUN_BIN} ${PATHS.OPENCLAW_BIN} gateway --port 3000 --bind loopback`
    : `${PATHS.OPENCLAW_BIN} gateway --port 3000 --bind loopback`;

  return `#!/bin/bash
set -euo pipefail
gateway_token="$(cat ${PATHS.OPENCLAW_GATEWAY_TOKEN_PATH})"
export OPENCLAW_CONFIG_PATH="${PATHS.OPENCLAW_CONFIG_PATH}"
export OPENCLAW_GATEWAY_TOKEN="$gateway_token"
pkill -f "openclaw.gateway" 2>/dev/null || true
setsid ${gatewayCmd} >> ${PATHS.OPENCLAW_LOG_FILE} 2>&1 &
_ready_timeout="\${1:-60}"
_start_epoch=$(date +%s%N 2>/dev/null || echo 0)
_attempts=0
_ready=0
_deadline=$(( $(date +%s) + _ready_timeout ))
while [ "$(date +%s)" -lt "$_deadline" ]; do
  _attempts=$((_attempts + 1))
  if curl -s -f --max-time 1 http://localhost:3000/ 2>/dev/null | grep -q 'openclaw-app'; then
    _ready=1
    break
  fi
  sleep 0.1
done
_end_epoch=$(date +%s%N 2>/dev/null || echo 0)
_ready_ms=0
if [ "$_start_epoch" != "0" ] && [ "$_end_epoch" != "0" ]; then
  _ready_ms=$(( (_end_epoch - _start_epoch) / 1000000 ))
fi
if [ "$_ready" = "1" ]; then
  printf '{"ready":true,"attempts":%d,"readyMs":%d}\\n' "$_attempts" "$_ready_ms"
else
  printf '{"ready":false,"attempts":%d,"readyMs":%d}\\n' "$_attempts" "$_ready_ms"
  exit 1
fi
`;
}

// Create a sandbox, install openclaw, optionally install Bun, snapshot
async function bootstrap(variant) {
  log(`\n--- Bootstrap: ${variant} (vcpus=${VCPUS}) ---`);
  const t0 = Date.now();
  const sandbox = await Sandbox.create({
    ports: [3000],
    timeout: TIMEOUT_MS,
    resources: { vcpus: VCPUS },
  });
  log(`  created ${sandbox.name} in ${Date.now() - t0}ms`);

  // Install openclaw
  log(`  installing ${PACKAGE_SPEC}...`);
  const t1 = Date.now();
  const install = await sandbox.runCommand({
    cmd: "npm",
    args: ["install", "-g", PACKAGE_SPEC, "--ignore-scripts"],
    env: { NPM_CONFIG_CACHE: "/tmp/openclaw-npm-cache" },
  });
  if (install.exitCode !== 0) {
    throw new Error(`npm install failed: ${(await install.output("both")).slice(0, 500)}`);
  }
  log(`  installed in ${Date.now() - t1}ms`);

  // Install Bun (only for bun variant)
  if (variant === "bun") {
    log(`  installing Bun v${BUN_VERSION}...`);
    const t2 = Date.now();
    const bunInstall = await sandbox.runCommand("sh", [
      "-c",
      [
        "set -e",
        `curl -fsSL --max-time 60 --connect-timeout 10 -o /tmp/bun.zip ${JSON.stringify(BUN_DOWNLOAD_URL)}`,
        `printf '%s  /tmp/bun.zip\\n' ${JSON.stringify(BUN_DOWNLOAD_SHA256)} | sha256sum -c`,
        `mkdir -p ${JSON.stringify(BUN_INSTALL_DIR + "/bin")}`,
        `unzip -o -j /tmp/bun.zip -d ${JSON.stringify(BUN_INSTALL_DIR + "/bin")}`,
        `chmod +x ${JSON.stringify(PATHS.BUN_BIN)}`,
        `rm -f /tmp/bun.zip`,
        `${JSON.stringify(PATHS.BUN_BIN)} --version`,
      ].join(" && "),
    ]);
    if (bunInstall.exitCode !== 0) {
      throw new Error(`Bun install failed: ${(await bunInstall.output("both")).slice(0, 500)}`);
    }
    log(`  Bun installed in ${Date.now() - t2}ms`);
  }

  // Clean npm cache
  await sandbox.runCommand("bash", ["-lc", "rm -rf /home/vercel-sandbox/.npm /root/.npm /tmp/openclaw-npm-cache"]);

  // Write config files + fast-restore script
  const config = JSON.stringify({
    gateway: {
      mode: "local",
      auth: { mode: "token" },
      trustedProxies: ["10.0.0.0/8", "127.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
      controlUi: { dangerouslyDisableDeviceAuth: true },
      http: { endpoints: { chatCompletions: { enabled: true } } },
    },
  }, null, 2);

  await sandbox.writeFiles([
    { path: PATHS.OPENCLAW_CONFIG_PATH, content: Buffer.from(config) },
    { path: PATHS.OPENCLAW_GATEWAY_TOKEN_PATH, content: Buffer.from(`bench-token-${Date.now()}`) },
    { path: PATHS.OPENCLAW_AI_GATEWAY_API_KEY_PATH, content: Buffer.from("") },
    { path: PATHS.OPENCLAW_FAST_RESTORE_SCRIPT_PATH, content: Buffer.from(buildFastRestoreScript(variant)) },
  ]);
  await sandbox.runCommand("chmod", ["+x", PATHS.OPENCLAW_FAST_RESTORE_SCRIPT_PATH]);

  // Measure disk usage before snapshot
  const du = await sandbox.runCommand("du", ["-sh", "/"]);
  const diskUsage = (await du.output("stdout")).trim();
  log(`  disk usage: ${diskUsage}`);

  // Snapshot
  log(`  snapshotting...`);
  const snapStart = Date.now();
  const snap = await sandbox.snapshot();
  const snapMs = Date.now() - snapStart;
  const sizeMB = (snap.sizeBytes / 1024 / 1024).toFixed(1);
  log(`  snapshot ${snap.snapshotId} (${sizeMB} MB) in ${snapMs}ms`);

  return { snapshotId: snap.snapshotId, sizeBytes: snap.sizeBytes, snapMs };
}

// Restore from snapshot and measure boot time
async function benchRestore(snapshotId, variant, cycle) {
  const totalStart = Date.now();

  const createStart = Date.now();
  const sandbox = await Sandbox.create({
    source: { type: "snapshot", snapshotId },
    ports: [3000],
    timeout: TIMEOUT_MS,
    resources: { vcpus: VCPUS },
  });
  const sandboxCreateMs = Date.now() - createStart;

  const scriptStart = Date.now();
  const result = await sandbox.runCommand("bash", [PATHS.OPENCLAW_FAST_RESTORE_SCRIPT_PATH, "60"]);
  const scriptMs = Date.now() - scriptStart;

  let scriptOutput = {};
  if (result.exitCode === 0) {
    try {
      scriptOutput = JSON.parse((await result.output("stdout")).trim());
    } catch {
      scriptOutput = { ready: true, parseError: true };
    }
  } else {
    const out = await result.output("both");
    scriptOutput = { ready: false, exitCode: result.exitCode, output: out.slice(0, 500) };
  }

  const totalMs = Date.now() - totalStart;

  // Re-snapshot for next cycle
  const snap = await sandbox.snapshot();

  return {
    cycle,
    variant,
    sandboxCreateMs,
    scriptMs,
    readyMs: scriptOutput.readyMs ?? scriptMs,
    attempts: scriptOutput.attempts ?? -1,
    ready: scriptOutput.ready ?? false,
    totalMs,
    nextSnapshotId: snap.snapshotId,
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(vals) {
  const sorted = [...vals].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 50),
    avg: Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

// Main
async function main() {
  log(`bench-bun-vs-node`);
  log(`  package: ${PACKAGE_SPEC}`);
  log(`  cycles:  ${CYCLES}`);
  log(`  vcpus:   ${VCPUS}`);

  const report = {};

  for (const variant of ["node", "bun"]) {
    log(`\n========== ${variant.toUpperCase()} ==========`);

    const bs = await bootstrap(variant);
    let snapshotId = bs.snapshotId;

    const samples = [];
    for (let i = 1; i <= CYCLES; i++) {
      log(`  cycle ${i}/${CYCLES}`);
      try {
        const r = await benchRestore(snapshotId, variant, i);
        samples.push(r);
        snapshotId = r.nextSnapshotId;
        log(`    create=${r.sandboxCreateMs}ms script=${r.scriptMs}ms readyMs=${r.readyMs}ms total=${r.totalMs}ms`);
      } catch (err) {
        log(`    FAILED: ${err.message}`);
        samples.push({ cycle: i, variant, error: err.message });
      }
    }

    const ok = samples.filter((s) => !s.error);
    report[variant] = {
      snapshotSizeMB: (bs.sizeBytes / 1024 / 1024).toFixed(1),
      snapshotMs: bs.snapMs,
      samples,
      summary: ok.length > 0 ? {
        sandboxCreateMs: summarize(ok.map((s) => s.sandboxCreateMs)),
        scriptMs: summarize(ok.map((s) => s.scriptMs)),
        readyMs: summarize(ok.map((s) => s.readyMs)),
        totalMs: summarize(ok.map((s) => s.totalMs)),
      } : null,
    };

    if (report[variant].summary) {
      const s = report[variant].summary;
      log(`\n  --- ${variant} summary ---`);
      log(`    snapshot size: ${report[variant].snapshotSizeMB} MB`);
      log(`    sandboxCreate: p50=${s.sandboxCreateMs.p50}ms avg=${s.sandboxCreateMs.avg}ms`);
      log(`    scriptMs:      p50=${s.scriptMs.p50}ms avg=${s.scriptMs.avg}ms`);
      log(`    readyMs:       p50=${s.readyMs.p50}ms avg=${s.readyMs.avg}ms`);
      log(`    total:         p50=${s.totalMs.p50}ms avg=${s.totalMs.avg}ms`);
    }
  }

  // Comparison
  if (report.node?.summary && report.bun?.summary) {
    const nodeTot = report.node.summary.totalMs.avg;
    const bunTot = report.bun.summary.totalMs.avg;
    const diff = nodeTot - bunTot;
    const pct = ((diff / nodeTot) * 100).toFixed(1);
    log(`\n========== COMPARISON ==========`);
    log(`  Node snapshot: ${report.node.snapshotSizeMB} MB`);
    log(`  Bun snapshot:  ${report.bun.snapshotSizeMB} MB`);
    log(`  Size overhead: ${(report.bun.snapshotSizeMB - report.node.snapshotSizeMB).toFixed(1)} MB`);
    log(`  Node avg total: ${nodeTot}ms`);
    log(`  Bun avg total:  ${bunTot}ms`);
    log(`  Difference:     ${diff > 0 ? `Bun is ${diff}ms (${pct}%) faster` : `Node is ${-diff}ms (${(-pct)}%) faster`}`);
  }

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(`\nFATAL: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
