/**
 * Experiment: Bun bundle gateway v2
 *
 * The v1 experiment showed the CLI wrapper (openclaw.mjs) is only 2KB — it
 * doesn't inline deps. This version:
 * 1. Finds the actual gateway entry point in dist/
 * 2. Bundles it with --target bun to inline node_modules
 * 3. Benchmarks normal bun vs bundled bun vs node
 *
 * From v1 we know: Bun normal ~3800ms, Node ~unknown (need to test)
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

const OPENCLAW_BIN = "/home/vercel-sandbox/.global/npm/bin/openclaw";
const OPENCLAW_PKG_DIR =
  "/home/vercel-sandbox/.global/npm/lib/node_modules/openclaw";
const BUN_INSTALL_DIR = "/home/vercel-sandbox/.bun";
const BUN_BIN = `${BUN_INSTALL_DIR}/bin/bun`;
const BUN_VERSION = "1.3.11";
const BUN_DOWNLOAD_URL = `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip`;
const BUN_DOWNLOAD_SHA256 =
  "8611ba935af886f05a6f38740a15160326c15e5d5d07adef966130b4493607ed";
const BUNDLE_DIR = "/home/vercel-sandbox/.openclaw-bundle";
const PORT = 3000;

async function getStdout(result) {
  return (await result.stdout()).trim();
}

console.log("Creating fresh sandbox (1 vCPU)...");
const sandbox = await Sandbox.create({
  ports: [PORT],
  timeout: 180_000,
  resources: { vcpus: 1 },
});
console.log(`Sandbox created\n`);

// Step 1: Install openclaw + bun
console.log("=== Installing openclaw + bun ===");
const installResult = await sandbox.runCommand("sh", [
  "-c",
  [
    `npm install -g openclaw@latest --ignore-scripts`,
    `curl -fsSL --max-time 60 -o /tmp/bun.zip ${JSON.stringify(BUN_DOWNLOAD_URL)}`,
    `printf '%s  /tmp/bun.zip\\n' ${JSON.stringify(BUN_DOWNLOAD_SHA256)} | sha256sum -c`,
    `mkdir -p ${BUN_INSTALL_DIR}/bin`,
    `unzip -o -j /tmp/bun.zip -d ${BUN_INSTALL_DIR}/bin`,
    `chmod +x ${BUN_BIN}`,
    `rm -f /tmp/bun.zip`,
  ].join(" && "),
]);
if (installResult.exitCode !== 0) {
  console.error("Install failed:", await installResult.output("both"));
  process.exit(1);
}
console.log("Installed.");

// Step 2: Find the real gateway entry point inside dist/
console.log("\n=== Finding gateway entry point ===");
const findResult = await sandbox.runCommand("sh", [
  "-c",
  [
    // The CLI shim (openclaw.mjs) dynamically imports from dist/ based on the subcommand.
    // Let's find what 'gateway' maps to.
    `echo "=== grep gateway in openclaw.mjs ==="`,
    `grep -n 'gateway' ${OPENCLAW_PKG_DIR}/openclaw.mjs | head -10`,
    `echo ""`,
    // Look for gateway entry files in dist
    `echo "=== gateway-related files in dist/ ==="`,
    `ls -la ${OPENCLAW_PKG_DIR}/dist/gateway* 2>/dev/null || echo "no gateway* files"`,
    `ls -la ${OPENCLAW_PKG_DIR}/dist/cli-gateway* 2>/dev/null || echo "no cli-gateway* files"`,
    `echo ""`,
    // Search for the gateway command registration
    `echo "=== Full openclaw.mjs (it is small) ==="`,
    `cat ${OPENCLAW_PKG_DIR}/openclaw.mjs`,
  ].join("\n"),
]);
console.log(await getStdout(findResult));

// Step 3: Find what gateway.js looks like
console.log("\n=== Finding gateway dist files ===");
const gatewayFiles = await sandbox.runCommand("sh", [
  "-c",
  [
    `echo "=== files matching *gateway* ==="`,
    `find ${OPENCLAW_PKG_DIR}/dist -name "*gateway*" -type f | head -20`,
    `echo ""`,
    `echo "=== files matching *cli* ==="`,
    `find ${OPENCLAW_PKG_DIR}/dist -name "*cli*" -type f | head -20`,
    `echo ""`,
    // Check the dist directory structure
    `echo "=== dist subdirectories ==="`,
    `ls -d ${OPENCLAW_PKG_DIR}/dist/*/ 2>/dev/null | head -20`,
  ].join("\n"),
]);
console.log(await getStdout(gatewayFiles));

// Step 4: Check what imports happen when 'gateway' command is used
console.log("\n=== Tracing gateway imports ===");
const traceResult = await sandbox.runCommand("sh", [
  "-c",
  [
    // Use node to trace what gets loaded for the gateway command
    `cd ${OPENCLAW_PKG_DIR}`,
    `echo "=== Checking how CLI dispatches 'gateway' ==="`,
    // The openclaw.mjs likely does dynamic import based on subcommand
    // Let's see what modules are in dist/
    `ls ${OPENCLAW_PKG_DIR}/dist/*.js | head -40`,
    `echo ""`,
    `echo "=== Looking for gateway main in dist ==="`,
    `grep -rl "gateway.*--port\\|startGateway\\|createGateway" ${OPENCLAW_PKG_DIR}/dist/ 2>/dev/null | head -10`,
  ].join("\n"),
]);
console.log(await getStdout(traceResult));

// Step 5: Try to trace which file gets loaded first
console.log("\n=== Trace actual module loading ===");
const traceModules = await sandbox.runCommand("sh", [
  "-c",
  [
    `cd ${OPENCLAW_PKG_DIR}`,
    // Use NODE_OPTIONS to trace ESM loading
    `timeout 5 ${BUN_BIN} --print "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('${OPENCLAW_PKG_DIR}/package.json','utf8'));
      const imports = pkg.imports || {};
      console.log('Package imports:', JSON.stringify(Object.keys(imports).filter(k=>k.includes('gateway')||k.includes('cli')),null,2));
      const exp = pkg.exports || {};
      console.log('Package exports:', JSON.stringify(Object.keys(exp).filter(k=>k.includes('gateway')||k.includes('cli')),null,2));
    " 2>&1 || true`,
  ].join("\n"),
]);
console.log(await getStdout(traceModules));

// Step 6: Check if there is a direct gateway entry we can bundle
console.log("\n=== Trying to find direct gateway entry ===");
const directEntry = await sandbox.runCommand("sh", [
  "-c",
  [
    // Look for files that export a gateway start function
    `grep -l "gatewayCommand\\|runGateway\\|gateway.*action\\|parseArgs.*gateway" ${OPENCLAW_PKG_DIR}/dist/*.js 2>/dev/null | head -5`,
    `echo "---"`,
    // Also check package.json exports
    `node -e "
      const p = require('${OPENCLAW_PKG_DIR}/package.json');
      console.log('bin:', JSON.stringify(p.bin));
      if (p.exports) {
        const keys = Object.keys(p.exports);
        console.log('exports keys (first 20):', keys.slice(0,20));
      }
      if (p.imports) {
        const keys = Object.keys(p.imports);
        const gw = keys.filter(k => k.includes('gateway') || k.includes('cli'));
        console.log('gateway/cli imports:', gw);
      }
    "`,
  ].join("\n"),
]);
console.log(await getStdout(directEntry));

// Step 7: Actually try the bundle approach - bundle the CLI entry point
// with all its dynamic imports resolved
console.log("\n=== Creating comprehensive bundle ===");
const bundleResult = await sandbox.runCommand("sh", [
  "-c",
  [
    `mkdir -p ${BUNDLE_DIR}`,
    // First, let's see what the CLI wrapper actually does for 'gateway'
    `head -100 ${OPENCLAW_PKG_DIR}/openclaw.mjs`,
  ].join("\n"),
]);
console.log(await getStdout(bundleResult));

// Write minimal config for benchmarking
await sandbox.runCommand("sh", [
  "-c",
  [
    `mkdir -p /home/vercel-sandbox/.openclaw`,
    `echo '{"gateway":{"mode":"local","auth":{"mode":"token"},"http":{"endpoints":{"chatCompletions":{"enabled":true}}}}}' > /home/vercel-sandbox/.openclaw/openclaw.json`,
    `echo 'test-token-123' > /home/vercel-sandbox/.openclaw/.gateway-token`,
    `echo '' > /home/vercel-sandbox/.openclaw/.ai-gateway-api-key`,
  ].join("\n"),
]);

// Step 8: Benchmark what we can - Bun vs Node for the unmodified gateway
console.log("\n=== Benchmarking Bun vs Node (no bundle) ===");

const ITERATIONS = 3;

async function benchmarkBoot(label, launchCmd) {
  const times = [];
  for (let i = 0; i < ITERATIONS; i++) {
    await sandbox.runCommand("sh", [
      "-c",
      "pkill -f 'openclaw' 2>/dev/null; pkill -f 'bun.*gateway' 2>/dev/null; sleep 0.5",
    ]);

    const result = await sandbox.runCommand("sh", [
      "-c",
      [
        `_start=$(date +%s%N)`,
        `OPENCLAW_CONFIG_PATH=/home/vercel-sandbox/.openclaw/openclaw.json ` +
          `OPENCLAW_GATEWAY_TOKEN=test-token-123 ` +
          `${launchCmd} >> /tmp/bench-${label.replace(/\s/g, "-")}.log 2>&1 &`,
        `for j in $(seq 1 300); do`,
        `  if curl -s -f --max-time 1 http://localhost:${PORT}/ 2>/dev/null | grep -q 'openclaw-app'; then`,
        `    _end=$(date +%s%N)`,
        `    echo "$(( (_end - _start) / 1000000 ))"`,
        `    exit 0`,
        `  fi`,
        `  sleep 0.1`,
        `done`,
        `echo "TIMEOUT"`,
      ].join("\n"),
    ]);
    const ms = await getStdout(result);
    if (ms === "TIMEOUT") {
      console.log(`  ${label} #${i + 1}: TIMEOUT`);
      const logTail = await sandbox.runCommand("sh", [
        "-c",
        `tail -10 /tmp/bench-${label.replace(/\s/g, "-")}.log 2>/dev/null || echo 'no log'`,
      ]);
      console.log(`  Log: ${(await getStdout(logTail)).slice(0, 300)}`);
      times.push(-1);
    } else {
      const elapsed = parseInt(ms, 10);
      times.push(elapsed);
      console.log(`  ${label} #${i + 1}: ${elapsed}ms`);
    }

    await sandbox.runCommand("sh", [
      "-c",
      "pkill -f 'openclaw' 2>/dev/null; pkill -f 'bun' 2>/dev/null; sleep 0.5",
    ]);
  }
  return times.filter((t) => t > 0);
}

// Node baseline
console.log("\nNode + openclaw gateway:");
const nodeTimes = await benchmarkBoot(
  "node",
  `${OPENCLAW_BIN} gateway --port ${PORT} --bind loopback`,
);

// Bun
console.log("\nBun + openclaw gateway:");
const bunTimes = await benchmarkBoot(
  "bun",
  `${BUN_BIN} ${OPENCLAW_BIN} gateway --port ${PORT} --bind loopback`,
);

// Results
console.log("\n=== Final Results ===");
function summarize(label, times) {
  if (times.length === 0) {
    console.log(`${label}: all timed out`);
    return null;
  }
  const sorted = [...times].sort((a, b) => a - b);
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  console.log(
    `${label.padEnd(25)} avg=${avg}ms  min=${sorted[0]}ms  max=${sorted[sorted.length - 1]}ms  [${times.join(", ")}]`,
  );
  return avg;
}

const nodeAvg = summarize("Node (baseline)", nodeTimes);
const bunAvg = summarize("Bun (no bundle)", bunTimes);

if (nodeAvg && bunAvg) {
  const pct = ((1 - bunAvg / nodeAvg) * 100).toFixed(1);
  console.log(`\nBun speedup vs Node: ${pct}%`);
  console.log(`Bun saves ${nodeAvg - bunAvg}ms per boot`);
}

console.log(
  "\nNote: Bundle approach needs investigation into openclaw's dynamic import structure.",
);
console.log(
  "The CLI wrapper (openclaw.mjs) uses dynamic imports that bun build --target bun doesn't inline.",
);

console.log("\nStopping sandbox...");
await sandbox.stop();
console.log("Done.");
