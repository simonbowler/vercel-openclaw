#!/usr/bin/env node
/**
 * Experiment: Test .on-restore.sh auto-execution
 *
 * Vercel Sandbox has a special path: /vercel/sandbox/.on-restore.sh
 * If a script exists there when a snapshot is restored, it may auto-execute.
 *
 * RESULT: .on-restore.sh does NOT auto-execute because /vercel/sandbox/
 * is completely wiped during snapshot restore. No user files survive.
 * This was confirmed by writing files to /vercel/sandbox/, /tmp/, /opt/,
 * /home/, /root/, /usr/local/, /var/, and /etc/ — all are gone after restore.
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

async function getBothOutput(result) {
  try { return (await result.output("both")).trim(); } catch { return ""; }
}

console.log("=== Experiment: .on-restore.sh auto-execution ===\n");

// Step 1: Create a fresh sandbox
console.log("Step 1: Creating fresh sandbox...");
let t0 = performance.now();
const sandbox = await Sandbox.create({ timeoutMs: 120_000 });
console.log(`  Created sandbox ${sandbox.sandboxId} in ${ms(t0)}ms\n`);

// Step 2: Write .on-restore.sh
console.log("Step 2: Writing /vercel/sandbox/.on-restore.sh ...");
const onRestoreScript = `#!/bin/bash
# Marker: record that this script auto-executed
echo "auto-restored at \\$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /tmp/auto-restore-marker

# Start a simple HTTP server on port 9090 in background
nohup python3 -c "
import http.server, socketserver
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type','text/plain')
        self.end_headers()
        self.wfile.write(b'auto-ok')
    def log_message(self, *a): pass
socketserver.TCPServer(('',9090),H).serve_forever()
" > /tmp/auto-http.log 2>&1 &

# Also write PID so we can verify the process
echo \\$! > /tmp/auto-http-pid
`;

await sandbox.writeFiles([{ path: "/vercel/sandbox/.on-restore.sh", content: onRestoreScript }]);
await sandbox.runCommand("chmod", ["+x", "/vercel/sandbox/.on-restore.sh"]);
console.log("  Script written and made executable.\n");

// Verify the script is there
const checkResult = await sandbox.runCommand("ls", ["-la", "/vercel/sandbox/.on-restore.sh"]);
console.log("  Verification:", await getOutput(checkResult));

// Step 3: Snapshot the sandbox
console.log("\nStep 3: Creating snapshot...");
t0 = performance.now();
const snap = await sandbox.snapshot();
const snapshotMs = ms(t0);
// Extract snapshot ID from the snapshot object
const snapshotId = snap.snapshotId || snap.snapshot?.id || snap.id;
console.log(`  Snapshot: ${snapshotId} in ${snapshotMs}ms\n`);

await sandbox.stop();
console.log("  Original sandbox stopped.\n");

// Step 4: Restore from snapshot WITHOUT runCommand
console.log("Step 4: Restoring from snapshot (NO runCommand)...");
t0 = performance.now();
const restored = await Sandbox.create({ snapshot: snapshotId, timeoutMs: 120_000 });
const restoreMs = ms(t0);
console.log(`  Restored sandbox ${restored.sandboxId} in ${restoreMs}ms\n`);

// Step 5: Check if auto-execution happened
console.log("Step 5: Checking for auto-execution evidence...\n");

// Wait a bit for any auto-exec script to finish
await new Promise(r => setTimeout(r, 5000));

// Check 5a: Does the marker file exist? (use runCommand since readFileToBuffer API may differ)
let markerExists = false;
let markerContent = "";
try {
  const result = await restored.runCommand("cat", ["/tmp/auto-restore-marker"]);
  markerContent = await getOutput(result);
  markerExists = markerContent.length > 0 && result.exitCode === 0;
  console.log(`  [CHECK] /tmp/auto-restore-marker: exitCode=${result.exitCode} content="${markerContent}"`);
} catch (e) {
  console.log(`  [CHECK] /tmp/auto-restore-marker: ERROR ${e.message}`);
}

// Check 5b: Is port 9090 serving?
let httpOk = false;
try {
  const host = restored.domain(9090);
  const url = `https://${host}`;
  console.log(`  [CHECK] Fetching ${url} ...`);
  const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const body = await resp.text();
  httpOk = body.includes("auto-ok");
  console.log(`  [CHECK] HTTP 9090 response: status=${resp.status} body="${body.slice(0, 100)}" => ${httpOk ? "SUCCESS" : "FAIL"}`);
} catch (e) {
  console.log(`  [CHECK] HTTP 9090 UNREACHABLE: ${e.message}`);
}

// Check 5c: Diagnostic - check processes, files, and .on-restore.sh presence
try {
  const diag = await restored.runCommand("bash", ["-c",
    "echo '=== .on-restore.sh ===' && ls -la /vercel/sandbox/.on-restore.sh 2>&1 && echo '=== marker ===' && cat /tmp/auto-restore-marker 2>&1 && echo '=== pid ===' && cat /tmp/auto-http-pid 2>&1 && echo '=== processes ===' && ps aux 2>&1 && echo '=== listening ===' && (ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || echo 'no ss/netstat')"
  ]);
  console.log("\n  Diagnostic output:");
  const output = await getBothOutput(diag);
  console.log(output.split("\n").map(l => "    " + l).join("\n"));
} catch (e) {
  console.log(`  Diagnostic failed: ${e.message}`);
}

// Cleanup
await restored.stop();
console.log("\n  Restored sandbox stopped.\n");

// Summary
console.log("=== RESULTS ===");
console.log(`  Snapshot time:       ${snapshotMs}ms`);
console.log(`  Restore time:        ${restoreMs}ms`);
console.log(`  Marker file exists:  ${markerExists}`);
console.log(`  HTTP server running: ${httpOk}`);
console.log(`  Auto-execution:      ${markerExists && httpOk ? "CONFIRMED" : markerExists ? "PARTIAL (marker but no HTTP)" : "NOT DETECTED"}`);
console.log("");

if (markerExists && httpOk) {
  console.log("  CONCLUSION: .on-restore.sh IS auto-executed on snapshot restore!");
  console.log("  This means we can eliminate runCommand overhead (~6s) by putting");
  console.log("  the gateway startup script in .on-restore.sh before snapshotting.");
} else if (markerExists) {
  console.log("  CONCLUSION: .on-restore.sh script ran but HTTP server didn't start.");
  console.log("  The auto-execution mechanism exists but may have limitations.");
} else {
  console.log("  CONCLUSION: .on-restore.sh is NOT auto-executed on restore.");
  console.log("  We need alternative approaches to eliminate runCommand overhead.");
}
