#!/usr/bin/env node
/**
 * Experiment: Domain probe latency
 *
 * Measures how long it takes from sandbox start to first successful
 * fetch via sandbox.domain(port). Tests:
 * - Cold start: time from create to first successful fetch
 * - Pre-warm: rapid polling to detect earliest ready moment
 * - First vs subsequent fetch latency
 * - Snapshot restore: domain readiness after restore
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
const SUBSEQUENT_FETCHES = 10;

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
  if (times.length === 0) return { min: 0, p50: 0, p95: 0, max: 0, mean: 0 };
  const sorted = [...times].sort((a, b) => a - b);
  return {
    min: sorted[0],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
    mean: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
  };
}

async function probeUntilReady(url, timeoutMs = 30_000) {
  const start = performance.now();
  let attempts = 0;
  let lastError = null;

  while (performance.now() - start < timeoutMs) {
    attempts++;
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(3000),
        redirect: "follow",
      });
      if (resp.ok) {
        const elapsed = ms(start);
        return { elapsed, attempts, status: resp.status };
      }
      lastError = `HTTP ${resp.status}`;
    } catch (e) {
      lastError = e.message;
    }
    // Poll every 100ms
    await new Promise((r) => setTimeout(r, 100));
  }

  return { elapsed: -1, attempts, error: lastError };
}

// ── Phase 1: Create sandbox with a simple HTTP server, measure domain readiness ──
console.log("=== Phase 1: Domain probe latency from fresh create ===");

const createToReadyTimes = [];
const firstFetchTimes = [];
const subsequentFetchTimes = [];

for (let i = 0; i < CYCLES; i++) {
  console.log(`\n--- Cycle ${i + 1}/${CYCLES} ---`);

  const createStart = performance.now();
  const sandbox = await Sandbox.create({ timeoutMs: 60_000, ports: [3000] });
  const createMs = ms(createStart);
  console.log(`  Sandbox created in ${createMs}ms — id: ${sandbox.sandboxId}`);

  // Start a simple HTTP server (fire and forget)
  sandbox.runCommand("node", [
    "-e",
    'require("http").createServer((q,s)=>{s.writeHead(200);s.end("ok")}).listen(3000)',
  ]).catch(() => {});

  // Get the domain URL — domain() returns a full hostname like sb-xxx.vercel.run
  const domainVal = sandbox.domain(3000);
  const url = domainVal.startsWith("http") ? domainVal : `https://${domainVal}`;
  console.log(`  Domain: ${url}`);

  // Probe until ready
  const probe = await probeUntilReady(url);
  const totalFromCreate = ms(createStart);

  if (probe.elapsed === -1) {
    console.log(`  FAILED to reach domain after ${probe.attempts} attempts: ${probe.error}`);
    await sandbox.stop();
    continue;
  }

  console.log(`  First successful fetch: ${probe.elapsed}ms after server start cmd (${probe.attempts} attempts)`);
  console.log(`  Total from create: ${totalFromCreate}ms`);
  createToReadyTimes.push(totalFromCreate);
  firstFetchTimes.push(probe.elapsed);

  // Measure subsequent fetches
  const subTimes = [];
  for (let j = 0; j < SUBSEQUENT_FETCHES; j++) {
    const t0 = performance.now();
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      await resp.text();
      subTimes.push(ms(t0));
    } catch (e) {
      subTimes.push(-1);
    }
  }
  subsequentFetchTimes.push(...subTimes.filter((t) => t >= 0));

  const subStats = stats(subTimes.filter((t) => t >= 0));
  console.log(`  Subsequent fetches: min=${subStats.min}ms p50=${subStats.p50}ms p95=${subStats.p95}ms max=${subStats.max}ms`);

  await sandbox.stop();
}

// ── Phase 2: Snapshot restore + domain probe ──
console.log("\n\n=== Phase 2: Domain probe latency from snapshot restore ===");

// Create a sandbox with server script, snapshot it
console.log("Creating sandbox with server script for snapshot...");
const setupSandbox = await Sandbox.create({ timeoutMs: 60_000, ports: [3000] });

// Write server script
// Write server script via runCommand (writeFiles has permission issues with /root)
await setupSandbox.runCommand("sh", ["-c", 'cat > /home/vercel-sandbox/server.js << \'EOF\'\nrequire("http").createServer((q, s) => { s.writeHead(200); s.end("ok-from-snapshot"); }).listen(3000);\nEOF']);

// Start the server and verify
setupSandbox.runCommand("node", ["/home/vercel-sandbox/server.js"]).catch(() => {});
await new Promise((r) => setTimeout(r, 1500));

const setupDomain = setupSandbox.domain(3000);
const setupUrl = setupDomain.startsWith("http") ? setupDomain : `https://${setupDomain}`;
const setupProbe = await probeUntilReady(setupUrl);
console.log(`  Server ready: ${setupProbe.elapsed}ms`);

const snap = await setupSandbox.snapshot();
const snapshotId = snap.snapshotId || snap.snapshot?.id || snap.id;
console.log(`  Snapshot: ${snapshotId}`);
await setupSandbox.stop();

const restoreToReadyTimes = [];

for (let i = 0; i < CYCLES; i++) {
  console.log(`\n--- Restore cycle ${i + 1}/${CYCLES} ---`);

  const restoreStart = performance.now();
  const restored = await Sandbox.create({
    snapshot: snapshotId,
    timeoutMs: 60_000,
    ports: [3000],
  });
  const restoreMs = ms(restoreStart);

  // Server process won't survive snapshot — start it again
  restored.runCommand("node", ["/home/vercel-sandbox/server.js"]).catch(() => {});

  const restoredDomain = restored.domain(3000);
  const restoredUrl = restoredDomain.startsWith("http") ? restoredDomain : `https://${restoredDomain}`;
  const probe = await probeUntilReady(restoredUrl);

  if (probe.elapsed === -1) {
    console.log(`  FAILED — restore ${restoreMs}ms, domain never ready: ${probe.error}`);
  } else {
    const total = ms(restoreStart);
    console.log(`  Restore: ${restoreMs}ms, domain ready: ${probe.elapsed}ms after restore, total: ${total}ms (${probe.attempts} attempts)`);
    restoreToReadyTimes.push(total);
  }

  await restored.stop();
}

// ── Results ──
console.log("\n\n=== RESULTS ===");

if (createToReadyTimes.length > 0) {
  const ctrStats = stats(createToReadyTimes);
  console.log(`\nFresh create -> domain ready (${createToReadyTimes.length} cycles):`);
  console.log(`  min=${ctrStats.min}ms  p50=${ctrStats.p50}ms  p95=${ctrStats.p95}ms  max=${ctrStats.max}ms  mean=${ctrStats.mean}ms`);
  console.log(`  raw: [${createToReadyTimes.join(", ")}]`);
}

if (firstFetchTimes.length > 0) {
  const ffStats = stats(firstFetchTimes);
  console.log(`\nFirst fetch latency after server start (${firstFetchTimes.length} cycles):`);
  console.log(`  min=${ffStats.min}ms  p50=${ffStats.p50}ms  p95=${ffStats.p95}ms  max=${ffStats.max}ms  mean=${ffStats.mean}ms`);
  console.log(`  raw: [${firstFetchTimes.join(", ")}]`);
}

if (subsequentFetchTimes.length > 0) {
  const subStats = stats(subsequentFetchTimes);
  console.log(`\nSubsequent fetch latency (${subsequentFetchTimes.length} fetches):`);
  console.log(`  min=${subStats.min}ms  p50=${subStats.p50}ms  p95=${subStats.p95}ms  max=${subStats.max}ms  mean=${subStats.mean}ms`);
}

if (restoreToReadyTimes.length > 0) {
  const rtrStats = stats(restoreToReadyTimes);
  console.log(`\nSnapshot restore -> domain ready (${restoreToReadyTimes.length} cycles):`);
  console.log(`  min=${rtrStats.min}ms  p50=${rtrStats.p50}ms  p95=${rtrStats.p95}ms  max=${rtrStats.max}ms  mean=${rtrStats.mean}ms`);
  console.log(`  raw: [${restoreToReadyTimes.join(", ")}]`);
}

console.log("\nDone.");
