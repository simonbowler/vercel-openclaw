/**
 * Experiment: Measure absolute runCommand floor
 *
 * Creates a fresh sandbox and runs the simplest possible commands
 * to measure the minimum API overhead of runCommand.
 *
 * Runs 10 iterations of each command, computes p50/p95.
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

const commands = [
  { label: 'echo hello (direct)', cmd: "echo", args: ["hello"] },
  { label: 'sh -c "echo hello"', cmd: "sh", args: ["-c", "echo hello"] },
  { label: 'sh -c "exit 0"', cmd: "sh", args: ["-c", "exit 0"] },
  { label: 'bash -c "true"', cmd: "bash", args: ["-c", "true"] },
];

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

const results = {};

for (const { label, cmd, args } of commands) {
  const times = [];
  // Warm-up run (not counted)
  await sandbox.runCommand(cmd, args);

  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    await sandbox.runCommand(cmd, args);
    const elapsed = Math.round(performance.now() - start);
    times.push(elapsed);
  }

  const s = stats(times);
  results[label] = { ...s, raw: times };
  console.log(
    `${label.padEnd(25)} min=${s.min}ms  p50=${s.p50}ms  p95=${s.p95}ms  max=${s.max}ms  mean=${s.mean}ms`,
  );
}

console.log("\n--- Raw timings (ms) ---");
for (const [label, r] of Object.entries(results)) {
  console.log(`${label}: [${r.raw.join(", ")}]`);
}

// Cleanup
console.log("\nStopping sandbox...");
await sandbox.stop();
console.log("Done.");
