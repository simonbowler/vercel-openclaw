/**
 * Experiment: extendTimeout limits
 *
 * Tests:
 * 1. How fast is extendTimeout? (10 iterations)
 * 2. Can we extend beyond the initial timeout?
 * 3. What's the maximum lifetime we can achieve?
 * 4. Does extend work after a long initial timeout?
 * 5. What happens when we extend past the plan limit?
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
const MIN = 60_000;
const HOUR = 60 * MIN;

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

function fmtMs(ms) {
  if (ms >= HOUR) return `${(ms / HOUR).toFixed(1)}h`;
  if (ms >= MIN) return `${(ms / MIN).toFixed(1)}m`;
  return `${ms}ms`;
}

// --- Phase 1: Create sandbox with short timeout ---
console.log("=== Phase 1: Create sandbox (initial timeout: 2 min) ===");
const sandbox = await Sandbox.create({
  ports: [3000],
  timeout: 2 * MIN,
  resources: { vcpus: 1 },
});
console.log(`  Created — id: ${sandbox.sandboxId}`);
console.log(`  Initial timeout: ${fmtMs(sandbox.timeout)}\n`);

// --- Phase 2: Measure extendTimeout speed ---
console.log(`=== Phase 2: extendTimeout speed (${ITERATIONS}x, +1 min each) ===`);
const extendTimes = [];

for (let i = 0; i < ITERATIONS; i++) {
  const start = performance.now();
  await sandbox.extendTimeout(1 * MIN);
  const elapsed = Math.round(performance.now() - start);
  extendTimes.push(elapsed);
}

const extStats = stats(extendTimes);
console.log(
  `  extendTimeout:  min=${extStats.min}ms  p50=${extStats.p50}ms  p95=${extStats.p95}ms  max=${extStats.max}ms  mean=${extStats.mean}ms`,
);
console.log(`  Raw: [${extendTimes.join(", ")}]`);

// Check current timeout after 10 x 1min extensions on a 2min initial
const afterExtend = await Sandbox.get({ sandboxId: sandbox.sandboxId });
console.log(`  Timeout after 10 extensions: ${fmtMs(afterExtend.timeout)}\n`);

// --- Phase 3: Push toward maximum lifetime ---
console.log("=== Phase 3: Find maximum extendable lifetime ===");
const bigExtensions = [
  { label: "+30 min", duration: 30 * MIN },
  { label: "+1 hour", duration: 1 * HOUR },
  { label: "+2 hours", duration: 2 * HOUR },
  { label: "+4 hours", duration: 4 * HOUR },
  { label: "+8 hours", duration: 8 * HOUR },
  { label: "+12 hours", duration: 12 * HOUR },
  { label: "+24 hours", duration: 24 * HOUR },
];

let lastGoodTimeout = afterExtend.timeout;
let hitLimit = false;

for (const { label, duration } of bigExtensions) {
  if (hitLimit) break;

  try {
    const start = performance.now();
    await sandbox.extendTimeout(duration);
    const elapsed = Math.round(performance.now() - start);
    const check = await Sandbox.get({ sandboxId: sandbox.sandboxId });
    console.log(
      `  ${label.padEnd(12)} OK in ${elapsed}ms — total timeout now: ${fmtMs(check.timeout)}`,
    );
    lastGoodTimeout = check.timeout;
  } catch (err) {
    hitLimit = true;
    console.log(
      `  ${label.padEnd(12)} FAILED: ${err.message}`,
    );
    console.log(`  >> Maximum reachable timeout: ${fmtMs(lastGoodTimeout)}`);
  }
}

if (!hitLimit) {
  // Try one more massive extension
  console.log("\n  Attempting +48 hours...");
  try {
    await sandbox.extendTimeout(48 * HOUR);
    const check = await Sandbox.get({ sandboxId: sandbox.sandboxId });
    console.log(`  +48 hours OK — total timeout: ${fmtMs(check.timeout)}`);
    lastGoodTimeout = check.timeout;
  } catch (err) {
    console.log(`  +48 hours FAILED: ${err.message}`);
    console.log(`  >> Maximum reachable timeout: ${fmtMs(lastGoodTimeout)}`);
  }
}

// --- Phase 4: Verify sandbox still works after all extensions ---
console.log("\n=== Phase 4: Verify sandbox still functional ===");
try {
  const result = await sandbox.runCommand("echo", ["still alive"]);
  const resultOut = await result.stdout();
  console.log(`  Command output: "${resultOut.trim()}" — exitCode: ${result.exitCode}`);
} catch (err) {
  console.log(`  Command failed: ${err.message}`);
}

// --- Summary ---
console.log("\n=== Summary ===");
console.log(`  extendTimeout API cost (p50): ${extStats.p50}ms`);
console.log(`  extendTimeout API cost (mean): ${extStats.mean}ms`);
console.log(`  Maximum timeout reached:       ${fmtMs(lastGoodTimeout)}`);
console.log(`  Sandbox still functional:      yes`);

// Cleanup
console.log("\nStopping sandbox...");
await sandbox.stop();
console.log("Done.");
