/**
 * Experiment: Hot snapshot — can you snapshot WITHOUT stopping?
 *
 * The SDK docs say "this sandbox will be stopped as part of the snapshot
 * creation process." This experiment verifies:
 *
 * 1. Start a sandbox with a background process (simple HTTP server)
 * 2. Call sandbox.snapshot() and measure the time
 * 3. Check: does the original sandbox survive? (status, can we run commands?)
 * 4. Restore from the snapshot — is the process still running?
 * 5. Compare snapshot+restore time to a fresh create
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

// --- Phase 1: Create sandbox with a background process ---
console.log("=== Phase 1: Create sandbox with background HTTP server ===");
const createStart = performance.now();
const sandbox = await Sandbox.create({
  ports: [3000, 9090],
  timeout: 120_000,
  resources: { vcpus: 1 },
});
const createMs = Math.round(performance.now() - createStart);
console.log(`  Created in ${createMs}ms — id: ${sandbox.sandboxId}`);

// Start a simple HTTP server in background
console.log("  Starting background HTTP server on port 9090...");
await sandbox.runCommand({
  cmd: "node",
  args: [
    "-e",
    `
    const http = require("http");
    const server = http.createServer((req, res) => {
      res.writeHead(200);
      res.end("alive-" + process.pid);
    });
    server.listen(9090, () => {
      console.log("Server listening on 9090, pid=" + process.pid);
    });
    `,
  ],
  detached: true,
});

// Give it a moment to bind
await new Promise((r) => setTimeout(r, 1000));

// Verify the server is running
const checkResult = await sandbox.runCommand("curl", [
  "-s",
  "http://localhost:9090",
]);
const checkOut = await checkResult.stdout();
console.log(`  Server check: "${checkOut.trim()}"\n`);

// Record the PID
const pidResult = await sandbox.runCommand("sh", [
  "-c",
  "curl -s http://localhost:9090 | grep -o '[0-9]*$'",
]);
const originalPid = (await pidResult.stdout()).trim();
console.log(`  Original server PID: ${originalPid}\n`);

// --- Phase 2: Snapshot the running sandbox ---
console.log("=== Phase 2: Snapshot running sandbox ===");
const snapshotStart = performance.now();
const snapshot = await sandbox.snapshot();
const snapshotMs = Math.round(performance.now() - snapshotStart);
console.log(`  Snapshot created in ${snapshotMs}ms — id: ${snapshot.snapshotId}`);
console.log(`  Snapshot status: ${snapshot.status}`);
console.log(`  Snapshot size: ${snapshot.sizeBytes} bytes\n`);

// --- Phase 3: Check if original sandbox survived ---
console.log("=== Phase 3: Check original sandbox after snapshot ===");
try {
  const rehydrated = await Sandbox.get({ sandboxId: sandbox.sandboxId });
  console.log(`  Original sandbox status: ${rehydrated.status}`);

  if (rehydrated.status === "running") {
    try {
      const postSnapshotCheck = await rehydrated.runCommand("curl", [
        "-s",
        "http://localhost:9090",
      ]);
      const postOut = await postSnapshotCheck.stdout();
      console.log(
        `  Server still alive: "${postOut.trim()}"`,
      );
    } catch (err) {
      console.log(`  Command after snapshot failed: ${err.message}`);
    }
  } else {
    console.log("  >> CONFIRMED: Sandbox was STOPPED by snapshot operation");
  }
} catch (err) {
  console.log(`  get() after snapshot failed: ${err.message}`);
}
console.log();

// --- Phase 4: Restore from snapshot ---
console.log("=== Phase 4: Restore from snapshot ===");
const restoreStart = performance.now();
const restored = await Sandbox.create({
  source: { type: "snapshot", snapshotId: snapshot.snapshotId },
  ports: [3000, 9090],
  timeout: 120_000,
  resources: { vcpus: 1 },
});
const restoreMs = Math.round(performance.now() - restoreStart);
console.log(`  Restored in ${restoreMs}ms — id: ${restored.sandboxId}`);
console.log(`  Restored sandbox status: ${restored.status}`);

// Check if the HTTP server process survived the snapshot
console.log("\n  Checking if HTTP server survived snapshot+restore...");
try {
  const restoredCheck = await restored.runCommand("curl", [
    "-s",
    "--connect-timeout",
    "3",
    "http://localhost:9090",
  ]);
  const restoredOut = await restoredCheck.stdout();
  console.log(`  Server response: "${restoredOut.trim()}"`);
  console.log("  >> Process SURVIVED snapshot+restore!");
} catch (err) {
  console.log(`  Server not responding: ${err.message}`);
  console.log("  >> Process did NOT survive snapshot+restore");
}

// Check if any node processes exist
const psResult = await restored.runCommand("sh", [
  "-c",
  "ps aux | grep node || true",
]);
const psOut = await psResult.stdout();
console.log(`\n  Process list (node):\n${psOut}`);

// --- Summary ---
console.log("\n=== Summary ===");
console.log(`  Fresh create:        ${createMs}ms`);
console.log(`  Snapshot time:       ${snapshotMs}ms`);
console.log(`  Restore time:        ${restoreMs}ms`);
console.log(`  Snapshot+Restore:    ${snapshotMs + restoreMs}ms`);

// Cleanup
console.log("\nCleaning up...");
try {
  await restored.stop();
} catch (e) {
  /* already stopped */
}
try {
  await snapshot.delete();
} catch (e) {
  /* best effort */
}
console.log("Done.");
