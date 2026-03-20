#!/usr/bin/env node
/**
 * Experiment: Concurrent sandbox pre-creation
 *
 * Test whether we can pre-create a sandbox from a snapshot while another
 * sandbox from the same snapshot is still running.
 *
 * KEY FINDING FROM PRIOR TEST: /tmp and /vercel/sandbox files do NOT survive
 * snapshot/restore. So we verify liveness via runCommand, not marker files.
 */

import { readFileSync } from "node:fs";

// Load OIDC credentials
const content = readFileSync(".env.local", "utf-8");
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

function ms(start) {
  return Math.round(performance.now() - start);
}

async function getOutput(result) {
  try { return (await result.output("stdout")).trim(); } catch { return ""; }
}

console.log("=== Experiment: Concurrent sandbox pre-creation ===\n");

// Step 1: Create base sandbox and snapshot
console.log("Step 1: Creating base sandbox and snapshotting...");
let t0 = performance.now();
const base = await Sandbox.create({ timeoutMs: 120_000 });
console.log(`  Created base sandbox ${base.sandboxId} in ${ms(t0)}ms`);

t0 = performance.now();
const snap = await base.snapshot();
const snapshotMs = ms(t0);
const snapshotId = snap.snapshotId || snap.snapshot?.id;
console.log(`  Snapshot: ${snapshotId} in ${snapshotMs}ms`);
await base.stop();
console.log("  Base sandbox stopped.\n");

// Step 2: Restore sandbox A
console.log("Step 2: Restoring sandbox A from snapshot...");
t0 = performance.now();
const sandboxA = await Sandbox.create({ snapshot: snapshotId, timeoutMs: 120_000 });
const restoreAMs = ms(t0);
console.log(`  Sandbox A: ${sandboxA.sandboxId} in ${restoreAMs}ms`);

// Write a unique marker AFTER restore and start HTTP server
await sandboxA.runCommand("bash", ["-c", "echo 'sandbox-A-alive' > /tmp/marker-A"]);
await sandboxA.runCommand("bash", ["-c", "nohup python3 -c \"import http.server,socketserver;socketserver.TCPServer(('',8080),http.server.SimpleHTTPRequestHandler).serve_forever()\" > /dev/null 2>&1 &"]);
await new Promise(r => setTimeout(r, 1000)); // let server start
console.log("  Marker written and HTTP server started on A.\n");

// Step 3: While A is running, restore sandbox B from same snapshot
console.log("Step 3: Restoring sandbox B from SAME snapshot (while A runs)...");
t0 = performance.now();
let sandboxB;
try {
  sandboxB = await Sandbox.create({ snapshot: snapshotId, timeoutMs: 120_000 });
  const restoreBMs = ms(t0);
  console.log(`  Sandbox B: ${sandboxB.sandboxId} in ${restoreBMs}ms\n`);

  // Step 4: Verify both exist simultaneously
  console.log("Step 4: Verifying both sandboxes are live...");

  // Check A is still alive with its marker
  const aMarkerResult = await sandboxA.runCommand("cat", ["/tmp/marker-A"]);
  const aMarker = await getOutput(aMarkerResult);
  const aAlive = aMarker === "sandbox-A-alive";
  console.log(`  Sandbox A alive: ${aAlive} (marker: "${aMarker}")`);

  // Check B is alive by running a command
  const bResult = await sandboxB.runCommand("echo", ["sandbox-B-alive"]);
  const bOutput = await getOutput(bResult);
  const bAlive = bOutput === "sandbox-B-alive";
  console.log(`  Sandbox B alive: ${bAlive} (echo: "${bOutput}")`);

  // Verify they are different sandboxes
  console.log(`  Sandbox A ID: ${sandboxA.sandboxId}`);
  console.log(`  Sandbox B ID: ${sandboxB.sandboxId}`);
  console.log(`  Different sandboxes: ${sandboxA.sandboxId !== sandboxB.sandboxId}`);

  // Check A's HTTP server
  try {
    const url = `https://${sandboxA.domain(8080)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    console.log(`  Sandbox A HTTP 8080: status=${resp.status}`);
  } catch (e) {
    console.log(`  Sandbox A HTTP 8080: ${e.message}`);
  }

  // Verify isolation: B should NOT have A's marker
  const bMarkerResult = await sandboxB.runCommand("bash", ["-c", "cat /tmp/marker-A 2>&1 || echo 'NOT FOUND'"]);
  const bMarkerCheck = await getOutput(bMarkerResult);
  console.log(`  Sandbox B has A's marker: ${!bMarkerCheck.includes("NOT FOUND") && !bMarkerCheck.includes("No such file")}`);

  console.log(`\n  Both running simultaneously: ${aAlive && bAlive}\n`);

  // Step 5: Measure runCommand latency on pre-created B
  console.log("Step 5: Measuring runCommand latency on pre-created sandbox B...");
  const timings = [];
  for (let i = 0; i < 5; i++) {
    t0 = performance.now();
    const r = await sandboxB.runCommand("echo", ["hello"]);
    const elapsed = ms(t0);
    timings.push(elapsed);
    console.log(`  Run ${i + 1}: ${elapsed}ms`);
  }

  // Heavier commands
  console.log("\n  Heavier commands on pre-created B:");
  t0 = performance.now();
  const heavy1 = await sandboxB.runCommand("python3", ["-c", "print(sum(range(100000)))"]);
  console.log(`  python3 sum: ${ms(t0)}ms (result: ${await getOutput(heavy1)})`);

  t0 = performance.now();
  const heavy2 = await sandboxB.runCommand("node", ["-e", "console.log(Array.from({length:1000},(_,i)=>i).reduce((a,b)=>a+b))"]);
  console.log(`  node sum: ${ms(t0)}ms (result: ${await getOutput(heavy2)})`);

  // Summary
  const avgRunCmd = Math.round(timings.reduce((a, b) => a + b, 0) / timings.length);
  console.log("\n=== RESULTS ===");
  console.log(`  Snapshot time:               ${snapshotMs}ms`);
  console.log(`  Restore A time:              ${restoreAMs}ms`);
  console.log(`  Restore B time (concurrent): ${restoreBMs}ms`);
  console.log(`  Both alive simultaneously:   ${aAlive && bAlive}`);
  console.log(`  Sandboxes are isolated:      ${sandboxA.sandboxId !== sandboxB.sandboxId}`);
  console.log(`  Avg runCommand on B:         ${avgRunCmd}ms`);
  console.log(`  Min runCommand on B:         ${Math.min(...timings)}ms`);
  console.log("");

  if (aAlive && bAlive) {
    console.log("  CONCLUSION: Concurrent pre-creation WORKS.");
    console.log("  Two sandboxes from the same snapshot can run simultaneously.");
    console.log("  Pre-creation strategy: while current sandbox is active, create");
    console.log("  the next one from the same snapshot so it's ready immediately.");
    console.log(`  Effective 'switch' latency: just runCommand overhead (~${avgRunCmd}ms)`);
  } else {
    console.log("  CONCLUSION: Concurrent pre-creation DOES NOT WORK.");
  }

  await sandboxB.stop();
} catch (e) {
  console.log(`  FAILED: ${e.message}`);
  console.log("\n=== RESULTS ===");
  console.log("  Concurrent creation from same snapshot: FAILED");
  console.log("  Error:", e.message);
}

await sandboxA.stop();
console.log("\n  All sandboxes cleaned up.");
