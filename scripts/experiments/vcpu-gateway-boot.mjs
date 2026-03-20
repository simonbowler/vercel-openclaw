/**
 * Experiment: Test 2 vCPU impact on gateway boot time
 *
 * Creates fresh sandboxes (1 vCPU and 2 vCPU), installs openclaw,
 * then measures gateway boot time repeatedly.
 *
 * Uses env vars to configure the gateway (matching bun-bundle-gateway-v3 pattern).
 * Compares 1 vCPU vs 2 vCPU across 3 cycles each.
 * Each vCPU setting uses a single sandbox for all cycles to avoid repeated install.
 */

import { readFileSync } from "node:fs";

const content = readFileSync(
  new URL("../../.env.local", import.meta.url),
  "utf-8",
);
for (const line of content.split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq === -1) continue;
  const k = t.slice(0, eq);
  let v = t.slice(eq + 1);
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  if (!process.env[k]) process.env[k] = v;
}

const { Sandbox } = await import("@vercel/sandbox");

const CYCLES = 5;
const PORT = 3000;
const OC_BIN = "/home/vercel-sandbox/.global/npm/bin/openclaw";

async function getStdout(result) {
  return ((await result.output()) || "").trim();
}

function percentile(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  return {
    min: sorted[0],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
    mean: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
  };
}

async function setupSandbox(vcpus) {
  console.log(`\nCreating ${vcpus}-vCPU sandbox...`);
  const createStart = performance.now();
  const sb = await Sandbox.create({
    ports: [PORT],
    timeout: 300_000,
    resources: { vcpus },
  });
  const createMs = Math.round(performance.now() - createStart);
  console.log(`  Created in ${createMs}ms (${sb.sandboxId})`);

  // Install openclaw
  console.log("  Installing openclaw...");
  const installStart = performance.now();
  const r = await sb.runCommand("sh", [
    "-c",
    "npm install -g openclaw@latest 2>&1 | tail -1",
  ]);
  const installMs = Math.round(performance.now() - installStart);
  console.log(`  Installed in ${installMs}ms: ${await getStdout(r)}`);

  // Write config
  await sb.runCommand("sh", [
    "-c",
    [
      "mkdir -p /home/vercel-sandbox/.openclaw",
      `echo '{"gateway":{"mode":"local","auth":{"mode":"token"},"http":{"endpoints":{"chatCompletions":{"enabled":true}}}}}' > /home/vercel-sandbox/.openclaw/openclaw.json`,
      `echo 'test-token-123' > /home/vercel-sandbox/.openclaw/.gateway-token`,
      `echo '' > /home/vercel-sandbox/.openclaw/.ai-gateway-api-key`,
    ].join(" && "),
  ]);

  return { sb, createMs, installMs };
}

async function benchmarkBoot(sb, cycleNum) {
  // Kill any leftover processes
  await sb.runCommand("sh", [
    "-c",
    "pkill -f 'openclaw' 2>/dev/null; pkill -f 'node.*gateway' 2>/dev/null; sleep 0.5; true",
  ]);

  const cmdStart = performance.now();
  const result = await sb.runCommand("sh", [
    "-c",
    [
      `_start=$(date +%s%N)`,
      `OPENCLAW_CONFIG_PATH=/home/vercel-sandbox/.openclaw/openclaw.json OPENCLAW_GATEWAY_TOKEN=test-token-123 node ${OC_BIN} gateway --port ${PORT} --bind loopback >> /tmp/bench.log 2>&1 &`,
      `for j in $(seq 1 300); do`,
      `  if curl -s -f --max-time 1 http://localhost:${PORT}/ 2>/dev/null | grep -q 'openclaw-app'; then`,
      `    _end=$(date +%s%N)`,
      `    echo "$(( (_end - _start) / 1000000 ))"`,
      `    exit 0`,
      `  fi`,
      `  sleep 0.1`,
      `done`,
      `echo "TIMEOUT"`,
    ].join("\n"),
  ]);
  const cmdMs = Math.round(performance.now() - cmdStart);
  const ms = await getStdout(result);

  if (ms === "TIMEOUT") {
    console.log(`  Cycle ${cycleNum + 1}: TIMEOUT (runCmd=${cmdMs}ms)`);
    const logTail = await sb.runCommand("sh", [
      "-c",
      "tail -10 /tmp/bench.log 2>/dev/null",
    ]);
    console.log(`  Log: ${(await getStdout(logTail)).slice(0, 300)}`);
    return { cmdMs, inSandboxMs: null, timedOut: true };
  }

  const inSandboxMs = parseInt(ms, 10);
  console.log(
    `  Cycle ${cycleNum + 1}: in-sandbox=${inSandboxMs}ms, runCmd=${cmdMs}ms`,
  );
  return { cmdMs, inSandboxMs, timedOut: false };
}

// Run experiments
const results = {};

for (const vcpus of [1, 2]) {
  console.log(`\n========== Testing ${vcpus} vCPU ==========`);
  const { sb, createMs, installMs } = await setupSandbox(vcpus);
  results[vcpus] = { createMs, installMs, cycles: [] };

  for (let i = 0; i < CYCLES; i++) {
    const r = await benchmarkBoot(sb, i);
    results[vcpus].cycles.push(r);
  }

  await sb.stop();
}

// Report
console.log("\n\n========== RESULTS ==========\n");

for (const vcpus of [1, 2]) {
  const data = results[vcpus];
  const inSandboxTimes = data.cycles
    .filter((c) => c.inSandboxMs !== null)
    .map((c) => c.inSandboxMs);
  const cmdTimes = data.cycles.map((c) => c.cmdMs);
  const timeouts = data.cycles.filter((c) => c.timedOut).length;

  console.log(`--- ${vcpus} vCPU ---`);
  console.log(`  Create: ${data.createMs}ms`);
  console.log(`  Install: ${data.installMs}ms`);
  if (inSandboxTimes.length > 0) {
    console.log(`  In-sandbox boot: ${JSON.stringify(stats(inSandboxTimes))}`);
  }
  console.log(`  runCommand:      ${JSON.stringify(stats(cmdTimes))}`);
  console.log(`  Timeouts: ${timeouts}/${CYCLES}`);
  console.log(`  Raw in-sandbox:  [${inSandboxTimes.join(", ")}]`);
  console.log(`  Raw runCmd:      [${cmdTimes.join(", ")}]`);
  console.log();
}

// Delta summary
const is1 = results[1].cycles
  .filter((c) => c.inSandboxMs !== null)
  .map((c) => c.inSandboxMs);
const is2 = results[2].cycles
  .filter((c) => c.inSandboxMs !== null)
  .map((c) => c.inSandboxMs);

if (is1.length > 0 && is2.length > 0) {
  const p50_1 = percentile(
    [...is1].sort((a, b) => a - b),
    50,
  );
  const p50_2 = percentile(
    [...is2].sort((a, b) => a - b),
    50,
  );
  console.log(
    `Gateway boot p50: 1vCPU=${p50_1}ms, 2vCPU=${p50_2}ms, delta=${p50_2 - p50_1}ms`,
  );
  console.log(
    `Install: 1vCPU=${results[1].installMs}ms, 2vCPU=${results[2].installMs}ms`,
  );
}

console.log("\nDone.");
