#!/usr/bin/env node
/**
 * Experiment: Snapshot size vs create speed
 *
 * Compares restore speed of minimal (~50MB) vs full openclaw (~535MB) snapshots.
 * Creates each snapshot type, then restores 5 times each, measuring timings.
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

const CYCLES = 5;

function ms(start) {
  return Math.round(performance.now() - start);
}

async function getOutput(result) {
  try { return (await result.output("stdout")).trim(); } catch { return ""; }
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

// ── Phase 1: Create minimal snapshot ──
console.log("=== Phase 1: Creating MINIMAL snapshot ===");
console.log("Creating fresh sandbox (no installs)...");
let t0 = performance.now();
const minimalSandbox = await Sandbox.create({ timeoutMs: 120_000 });
console.log(`Sandbox created in ${ms(t0)}ms — id: ${minimalSandbox.sandboxId}`);

// Write a small marker file so we can verify restore works
await minimalSandbox.runCommand("sh", ["-c", "echo minimal > /tmp/marker.txt"]);

console.log("Snapshotting minimal sandbox...");
t0 = performance.now();
const minimalSnap = await minimalSandbox.snapshot();
const minimalSnapshotMs = ms(t0);
const minimalSnapshotId = minimalSnap.snapshotId || minimalSnap.snapshot?.id || minimalSnap.id;
console.log(`Minimal snapshot created in ${minimalSnapshotMs}ms — id: ${minimalSnapshotId}`);

await minimalSandbox.stop();

// ── Phase 2: Create full openclaw snapshot ──
console.log("\n=== Phase 2: Creating FULL openclaw snapshot ===");
console.log("Creating fresh sandbox and installing openclaw...");
t0 = performance.now();
const fullSandbox = await Sandbox.create({ timeoutMs: 180_000 });
console.log(`Sandbox created in ${ms(t0)}ms — id: ${fullSandbox.sandboxId}`);

console.log("Installing openclaw (this will take a while)...");
t0 = performance.now();
const installResult = await fullSandbox.runCommand("npm", ["install", "-g", "openclaw@latest"], { timeout: 120_000 });
const installMs = ms(t0);
console.log(`openclaw installed in ${installMs}ms — exit code: ${installResult.exitCode}`);

// Check disk usage
const duResult = await fullSandbox.runCommand("sh", ["-c", "du -sh /usr/local/lib/node_modules/openclaw 2>/dev/null || du -sh /home/vercel-sandbox/.global/npm/lib/node_modules/openclaw 2>/dev/null || echo 'not found'"]);
const duOutput = await getOutput(duResult);
console.log(`openclaw size: ${duOutput}`);

console.log("Snapshotting full sandbox...");
t0 = performance.now();
const fullSnap = await fullSandbox.snapshot();
const fullSnapshotMs = ms(t0);
const fullSnapshotId = fullSnap.snapshotId || fullSnap.snapshot?.id || fullSnap.id;
console.log(`Full snapshot created in ${fullSnapshotMs}ms — id: ${fullSnapshotId}`);

await fullSandbox.stop();

// ── Phase 3: Restore minimal snapshot N times ──
console.log(`\n=== Phase 3: Restoring MINIMAL snapshot ${CYCLES} times ===`);
const minimalRestoreTimes = [];
for (let i = 0; i < CYCLES; i++) {
  const start = performance.now();
  const restored = await Sandbox.create({
    snapshot: minimalSnapshotId,
    timeoutMs: 60_000,
  });
  const elapsed = ms(start);
  minimalRestoreTimes.push(elapsed);

  // Quick liveness check
  const check = await restored.runCommand("echo", ["alive"]);
  const ok = (await getOutput(check)) === "alive";
  console.log(`  Cycle ${i + 1}: ${elapsed}ms (alive=${ok ? "OK" : "FAIL"})`);

  await restored.stop();
}

// ── Phase 4: Restore full snapshot N times ──
console.log(`\n=== Phase 4: Restoring FULL snapshot ${CYCLES} times ===`);
const fullRestoreTimes = [];
for (let i = 0; i < CYCLES; i++) {
  const start = performance.now();
  const restored = await Sandbox.create({
    snapshot: fullSnapshotId,
    timeoutMs: 60_000,
  });
  const elapsed = ms(start);
  fullRestoreTimes.push(elapsed);

  // Verify openclaw exists
  const check = await restored.runCommand("sh", ["-c", "which openclaw 2>/dev/null || echo missing"]);
  const checkOut = await getOutput(check);
  const ok = !checkOut.includes("missing");
  console.log(`  Cycle ${i + 1}: ${elapsed}ms (openclaw=${ok ? "OK" : "FAIL"})`);

  await restored.stop();
}

// ── Results ──
console.log("\n=== RESULTS ===");
const minStats = stats(minimalRestoreTimes);
const fullStats = stats(fullRestoreTimes);

console.log(`\nSnapshot creation:`);
console.log(`  Minimal: ${minimalSnapshotMs}ms`);
console.log(`  Full:    ${fullSnapshotMs}ms`);

console.log(`\nMinimal restore (${CYCLES} cycles):`);
console.log(`  min=${minStats.min}ms  p50=${minStats.p50}ms  p95=${minStats.p95}ms  max=${minStats.max}ms  mean=${minStats.mean}ms`);
console.log(`  raw: [${minimalRestoreTimes.join(", ")}]`);

console.log(`\nFull restore (${CYCLES} cycles):`);
console.log(`  min=${fullStats.min}ms  p50=${fullStats.p50}ms  p95=${fullStats.p95}ms  max=${fullStats.max}ms  mean=${fullStats.mean}ms`);
console.log(`  raw: [${fullRestoreTimes.join(", ")}]`);

console.log(`\nDelta (full - minimal):`);
console.log(`  p50: ${fullStats.p50 - minStats.p50 >= 0 ? "+" : ""}${fullStats.p50 - minStats.p50}ms`);
console.log(`  mean: ${fullStats.mean - minStats.mean >= 0 ? "+" : ""}${fullStats.mean - minStats.mean}ms`);

console.log("\nDone.");
