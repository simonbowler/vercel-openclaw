/**
 * Experiment: Sandbox.get() rehydration speed
 *
 * Measures how fast Sandbox.get() reattaches to a running sandbox
 * vs the cost of Sandbox.create(). Also tests get() on a stopped sandbox.
 *
 * Flow:
 * 1. Create a fresh sandbox — measure create time
 * 2. Call Sandbox.get() on the running sandbox 10 times — measure each
 * 3. Run a command via the rehydrated handle to prove it works
 * 4. Stop the sandbox
 * 5. Call Sandbox.get() on the stopped sandbox — measure and check status
 */

import { readFileSync } from "node:fs";

// Load OIDC credentials from .env.local
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

const ITERATIONS = 10;

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

// --- Phase 1: Create a fresh sandbox ---
console.log("=== Phase 1: Sandbox.create() baseline ===");
const createStart = performance.now();
const sandbox = await Sandbox.create({
  ports: [3000],
  timeout: 120_000,
  resources: { vcpus: 1 },
});
const createMs = Math.round(performance.now() - createStart);
console.log(`Sandbox created in ${createMs}ms — id: ${sandbox.sandboxId}`);
console.log(`Status: ${sandbox.status}\n`);

// --- Phase 2: Sandbox.get() on running sandbox ---
console.log(`=== Phase 2: Sandbox.get() on running sandbox (${ITERATIONS}x) ===`);
const getTimes = [];

for (let i = 0; i < ITERATIONS; i++) {
  const start = performance.now();
  const rehydrated = await Sandbox.get({ sandboxId: sandbox.sandboxId });
  const elapsed = Math.round(performance.now() - start);
  getTimes.push(elapsed);

  if (i === 0) {
    console.log(`  First get() status: ${rehydrated.status}`);
  }
}

const getStats = stats(getTimes);
console.log(
  `  get() on running:  min=${getStats.min}ms  p50=${getStats.p50}ms  p95=${getStats.p95}ms  max=${getStats.max}ms  mean=${getStats.mean}ms`,
);
console.log(`  Raw: [${getTimes.join(", ")}]\n`);

// --- Phase 3: Verify rehydrated handle works ---
console.log("=== Phase 3: Verify rehydrated handle can run commands ===");
const rehydrated = await Sandbox.get({ sandboxId: sandbox.sandboxId });
const cmdStart = performance.now();
const result = await rehydrated.runCommand("echo", ["hello from rehydrated"]);
const cmdMs = Math.round(performance.now() - cmdStart);
const cmdOut = await result.stdout();
console.log(`  Command via get() handle: exitCode=${result.exitCode}, output="${cmdOut.trim()}", took ${cmdMs}ms\n`);

// --- Phase 4: Stop the sandbox ---
console.log("=== Phase 4: Stop sandbox ===");
const stopStart = performance.now();
await sandbox.stop({ blocking: true });
const stopMs = Math.round(performance.now() - stopStart);
console.log(`  Stopped in ${stopMs}ms\n`);

// --- Phase 5: Sandbox.get() on stopped sandbox ---
console.log("=== Phase 5: Sandbox.get() on stopped sandbox ===");
const stoppedGetTimes = [];

for (let i = 0; i < 3; i++) {
  const start = performance.now();
  try {
    const stopped = await Sandbox.get({ sandboxId: sandbox.sandboxId });
    const elapsed = Math.round(performance.now() - start);
    stoppedGetTimes.push(elapsed);
    console.log(`  get() on stopped #${i + 1}: ${elapsed}ms — status: ${stopped.status}`);
  } catch (err) {
    const elapsed = Math.round(performance.now() - start);
    console.log(`  get() on stopped #${i + 1}: ${elapsed}ms — ERROR: ${err.message}`);
  }
}

// --- Summary ---
console.log("\n=== Summary ===");
console.log(`  Sandbox.create():           ${createMs}ms`);
console.log(`  Sandbox.get() running p50:  ${getStats.p50}ms`);
console.log(`  Sandbox.get() running mean: ${getStats.mean}ms`);
console.log(`  Speedup (create/get p50):   ${(createMs / getStats.p50).toFixed(1)}x`);
console.log(`  stop() blocking:            ${stopMs}ms`);
console.log("\nDone.");
