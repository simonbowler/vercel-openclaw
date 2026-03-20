/**
 * Experiment 9: Sequential vs parallel runCommands
 *
 * Tests whether:
 * - 2nd–5th sequential calls get faster (connection reuse)
 * - Promise.all of multiple runCommands works and is faster
 *
 * 10 iterations of the full sequence each time.
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
const CMD = "echo";
const ARGS = ["ok"];

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

console.log("Creating fresh sandbox (1 vCPU)...");
const createStart = performance.now();
const sandbox = await Sandbox.create({
  ports: [3000],
  timeout: 60_000,
  resources: { vcpus: 1 },
});
const createMs = Math.round(performance.now() - createStart);
console.log(`Sandbox created in ${createMs}ms — id: ${sandbox.id}\n`);

// --- Test 1: Sequential calls — do 2nd–5th get faster? ---
console.log("=== Sequential runCommand (5 calls per iteration) ===");
// Collect per-position timings across all iterations
const positionTimings = [[], [], [], [], []]; // positions 0-4

for (let iter = 0; iter < ITERATIONS; iter++) {
  for (let pos = 0; pos < 5; pos++) {
    const start = performance.now();
    await sandbox.runCommand(CMD, ARGS);
    const elapsed = Math.round(performance.now() - start);
    positionTimings[pos].push(elapsed);
  }
}

console.log("Position   min    p50    p95    max    mean");
for (let pos = 0; pos < 5; pos++) {
  const s = stats(positionTimings[pos]);
  console.log(
    `  #${pos + 1}      ${String(s.min).padStart(4)}   ${String(s.p50).padStart(4)}   ${String(s.p95).padStart(4)}   ${String(s.max).padStart(4)}   ${String(s.mean).padStart(4)}`,
  );
}

// --- Test 2: Promise.all parallel calls ---
console.log("\n=== Parallel runCommand via Promise.all ===");
for (const parallelCount of [2, 3, 5]) {
  const label = `Promise.all x${parallelCount}`;
  const times = [];

  // Warm-up
  await Promise.all(
    Array.from({ length: parallelCount }, () => sandbox.runCommand(CMD, ARGS)),
  );

  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    const results = await Promise.all(
      Array.from({ length: parallelCount }, () =>
        sandbox.runCommand(CMD, ARGS),
      ),
    );
    const elapsed = Math.round(performance.now() - start);
    times.push(elapsed);

    // Verify all succeeded
    const allOk = results.every((r) => r.exitCode === 0);
    if (!allOk) {
      console.log(`  WARNING: iteration ${i} had failures`);
    }
  }

  const s = stats(times);
  console.log(
    `${label.padEnd(25)} min=${s.min}ms  p50=${s.p50}ms  p95=${s.p95}ms  max=${s.max}ms  mean=${s.mean}ms`,
  );
  console.log(`  raw: [${times.join(", ")}]`);
}

// --- Test 3: Sequential total wall time for 5 commands ---
console.log("\n=== Wall time comparison: 5 sequential vs 5 parallel ===");
const seqTimes = [];
const parTimes = [];

for (let i = 0; i < ITERATIONS; i++) {
  // Sequential
  const seqStart = performance.now();
  for (let j = 0; j < 5; j++) {
    await sandbox.runCommand(CMD, ARGS);
  }
  seqTimes.push(Math.round(performance.now() - seqStart));

  // Parallel
  const parStart = performance.now();
  await Promise.all(
    Array.from({ length: 5 }, () => sandbox.runCommand(CMD, ARGS)),
  );
  parTimes.push(Math.round(performance.now() - parStart));
}

const seqS = stats(seqTimes);
const parS = stats(parTimes);
console.log(
  `Sequential x5:  min=${seqS.min}ms  p50=${seqS.p50}ms  p95=${seqS.p95}ms  mean=${seqS.mean}ms`,
);
console.log(
  `Parallel   x5:  min=${parS.min}ms  p50=${parS.p50}ms  p95=${parS.p95}ms  mean=${parS.mean}ms`,
);
console.log(`Speedup: ${(seqS.mean / parS.mean).toFixed(2)}x`);

console.log("\n--- Raw timings (ms) ---");
console.log("Sequential positions:");
for (let pos = 0; pos < 5; pos++) {
  console.log(`  #${pos + 1}: [${positionTimings[pos].join(", ")}]`);
}
console.log(`Sequential x5 wall: [${seqTimes.join(", ")}]`);
console.log(`Parallel x5 wall: [${parTimes.join(", ")}]`);

console.log("\nStopping sandbox...");
await sandbox.stop();
console.log("Done.");
