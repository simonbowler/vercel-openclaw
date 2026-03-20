/**
 * Experiment 8: readFileToBuffer API overhead floor
 *
 * Measures readFileToBuffer for:
 * - existing small file
 * - missing file (error path)
 * - large file (~1MB)
 *
 * 10 iterations each, computes p50/p95.
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

console.log("Creating fresh sandbox (1 vCPU)...");
const createStart = performance.now();
const sandbox = await Sandbox.create({
  ports: [3000],
  timeout: 60_000,
  resources: { vcpus: 1 },
});
const createMs = Math.round(performance.now() - createStart);
console.log(`Sandbox created in ${createMs}ms — id: ${sandbox.id}\n`);

// Prepare test files
console.log("Preparing test files...");
await sandbox.writeFiles([
  { path: "/tmp/small.txt", content: "hello world\n" },
]);
// Create a ~1MB file using writeFiles with repeated content
const largeContent = "x".repeat(1024 * 1024); // 1MB of 'x'
await sandbox.writeFiles([{ path: "/tmp/large.txt", content: largeContent }]);
console.log(`Large file written: ${largeContent.length} bytes`);
console.log();

const results = {};

// --- Test 1: Read existing small file ---
{
  const label = "small file (12 bytes)";
  const times = [];

  // Warm-up
  await sandbox.readFileToBuffer("/tmp/small.txt");

  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    await sandbox.readFileToBuffer("/tmp/small.txt");
    const elapsed = Math.round(performance.now() - start);
    times.push(elapsed);
  }

  const s = stats(times);
  results[label] = { ...s, raw: times };
  console.log(
    `${label.padEnd(30)} min=${s.min}ms  p50=${s.p50}ms  p95=${s.p95}ms  max=${s.max}ms  mean=${s.mean}ms`,
  );
}

// --- Test 2: Read missing file (error path) ---
{
  const label = "missing file (error)";
  const times = [];

  // Warm-up
  try {
    await sandbox.readFileToBuffer("/tmp/nonexistent.txt");
  } catch {}

  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    try {
      await sandbox.readFileToBuffer("/tmp/nonexistent.txt");
    } catch {}
    const elapsed = Math.round(performance.now() - start);
    times.push(elapsed);
  }

  const s = stats(times);
  results[label] = { ...s, raw: times };
  console.log(
    `${label.padEnd(30)} min=${s.min}ms  p50=${s.p50}ms  p95=${s.p95}ms  max=${s.max}ms  mean=${s.mean}ms`,
  );
}

// --- Test 3: Read large file (~1MB) ---
{
  const label = "large file (~1MB)";
  const times = [];
  let bufferSize = 0;

  // Warm-up
  const warmup = await sandbox.readFileToBuffer("/tmp/large.txt");
  bufferSize = warmup.length;

  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    await sandbox.readFileToBuffer("/tmp/large.txt");
    const elapsed = Math.round(performance.now() - start);
    times.push(elapsed);
  }

  const s = stats(times);
  results[label] = { ...s, raw: times };
  console.log(
    `${label.padEnd(30)} min=${s.min}ms  p50=${s.p50}ms  p95=${s.p95}ms  max=${s.max}ms  mean=${s.mean}ms`,
  );
  console.log(`  (buffer size: ${bufferSize} bytes)`);
}

console.log("\n--- Raw timings (ms) ---");
for (const [label, r] of Object.entries(results)) {
  console.log(`${label}: [${r.raw.join(", ")}]`);
}

console.log("\nStopping sandbox...");
await sandbox.stop();
console.log("Done.");
