/**
 * Experiment: Test detached runCommand mode
 *
 * Tests:
 * 1. Does detached return immediately? (measure return time)
 * 2. Does logs() streaming work on detached commands?
 * 3. Does a backgrounded process survive after detached returns?
 * 4. Normal runCommand vs detached for starting an HTTP server
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

console.log("Creating fresh sandbox (1 vCPU)...");
const sandbox = await Sandbox.create({
  ports: [3000],
  timeout: 60_000,
  resources: { vcpus: 1 },
});
console.log(`Sandbox created — id: ${sandbox.id}\n`);

// Helper: get stdout from a CommandFinished as a string
async function getStdout(result) {
  return (await result.stdout()).trim();
}

// -------------------------------------------------------
// Test 1: Does detached return immediately?
// -------------------------------------------------------
console.log("=== Test 1: Detached return time ===");
{
  // Normal: sleep 3 should take ~3s
  const normalStart = performance.now();
  await sandbox.runCommand("sleep", ["3"]);
  const normalMs = Math.round(performance.now() - normalStart);
  console.log(`Normal 'sleep 3':   ${normalMs}ms (expected ~3000ms)`);

  // Detached: sleep 3 should return immediately
  const detachedStart = performance.now();
  const cmd = await sandbox.runCommand({
    cmd: "sleep",
    args: ["3"],
    detached: true,
  });
  const detachedMs = Math.round(performance.now() - detachedStart);
  console.log(`Detached 'sleep 3': ${detachedMs}ms (expected <500ms)`);
  console.log(
    `Speedup: ${(normalMs / Math.max(detachedMs, 1)).toFixed(1)}x\n`,
  );
}

// -------------------------------------------------------
// Test 2: Does logs() streaming work on detached commands?
// -------------------------------------------------------
console.log("=== Test 2: Logs streaming on detached ===");
{
  const cmd = await sandbox.runCommand({
    cmd: "sh",
    args: [
      "-c",
      'for i in 1 2 3; do echo "log-line-$i"; sleep 0.5; done',
    ],
    detached: true,
  });
  const logLines = [];
  const logStart = performance.now();
  try {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 10_000);
    for await (const log of cmd.logs({ signal: ac.signal })) {
      logLines.push({
        ts: Math.round(performance.now() - logStart),
        text: log.data.trim(),
        stream: log.stream,
      });
    }
    clearTimeout(timeout);
  } catch (e) {
    if (e.name !== "AbortError") throw e;
  }
  console.log("Captured log lines:");
  for (const l of logLines) {
    console.log(`  [${l.ts}ms] (${l.stream}) ${l.text}`);
  }
  console.log(`Total lines: ${logLines.length} (expected 3)\n`);
}

// -------------------------------------------------------
// Test 3: Does a backgrounded process survive?
// -------------------------------------------------------
console.log("=== Test 3: Background process survival ===");
{
  // Start a detached command that writes to a file after a delay
  await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", "sleep 2 && echo 'survived' > /tmp/bg-test.txt"],
    detached: true,
  });
  console.log("Detached command launched, waiting 3s...");
  await new Promise((r) => setTimeout(r, 3000));

  const result = await sandbox.runCommand("cat", ["/tmp/bg-test.txt"]);
  const output = await getStdout(result);
  console.log(`File contents: '${output}' (expected 'survived')`);
  console.log(
    `Background survival: ${output === "survived" ? "PASS" : "FAIL"}\n`,
  );
}

// -------------------------------------------------------
// Test 4: Normal vs detached for starting an HTTP server
// -------------------------------------------------------
console.log("=== Test 4: HTTP server startup — normal vs detached ===");
{
  const serverScript = `
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('ok');
});
server.listen(8080, () => {
  console.log('SERVER_READY');
});
`;

  // Write server script
  await sandbox.runCommand("sh", [
    "-c",
    `cat > /tmp/server.js << 'SCRIPT'\n${serverScript}\nSCRIPT`,
  ]);

  // Method A: detached + poll from host
  await sandbox.runCommand("sh", [
    "-c",
    "pkill -f 'node /tmp/server.js' || true",
  ]);
  await new Promise((r) => setTimeout(r, 300));

  const detachedStart = performance.now();
  const cmd = await sandbox.runCommand({
    cmd: "node",
    args: ["/tmp/server.js"],
    detached: true,
  });
  const detachedReturnMs = Math.round(performance.now() - detachedStart);

  // Poll until server is up
  let serverReady = false;
  for (let i = 0; i < 20; i++) {
    const probe = await sandbox.runCommand("sh", [
      "-c",
      "curl -s http://localhost:8080 || true",
    ]);
    const probeOut = await getStdout(probe);
    if (probeOut === "ok") {
      serverReady = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const detachedReadyMs = Math.round(performance.now() - detachedStart);
  console.log(
    `Detached: returned in ${detachedReturnMs}ms, server ready in ${detachedReadyMs}ms (ready=${serverReady})`,
  );

  // Cleanup
  await sandbox.runCommand("sh", [
    "-c",
    "pkill -f 'node /tmp/server.js' || true",
  ]);
  await new Promise((r) => setTimeout(r, 500));

  // Method B: normal with bg + poll in single shell command
  const normalStart = performance.now();
  await sandbox.runCommand("sh", [
    "-c",
    `node /tmp/server.js &
for i in $(seq 1 20); do
  if curl -s http://localhost:8080 > /dev/null 2>&1; then
    echo READY;
    exit 0;
  fi;
  sleep 0.2;
done;
echo TIMEOUT`,
  ]);
  const normalReadyMs = Math.round(performance.now() - normalStart);
  console.log(`Normal (bg+poll in-sandbox): server ready in ${normalReadyMs}ms`);

  console.log(
    `\nDetached advantage: returns in ${detachedReturnMs}ms (fire-and-forget)`,
  );
  console.log(
    `But host-side polling adds ~150ms per probe. In-sandbox bg+poll avoids extra API calls.`,
  );

  // Cleanup
  await sandbox.runCommand("sh", [
    "-c",
    "pkill -f 'node /tmp/server.js' || true",
  ]);
}

console.log("\nStopping sandbox...");
await sandbox.stop();
console.log("Done.");
