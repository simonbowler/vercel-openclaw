/**
 * Experiment: Bun bundle gateway v3
 *
 * v2 showed: Bun (no bundle) ~3.6s vs Node ~5.2s (73% faster).
 * Bundle of openclaw.mjs was just 2KB (thin CLI wrapper, doesn't inline deps).
 *
 * This version tries bundling dist/entry.js (the real entry point) which should
 * inline the code-split chunks and node_modules into a single file.
 */

import { readFileSync } from "node:fs";

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
const BUNDLE_ENTRY = `${BUNDLE_DIR}/entry-bundle.js`;
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
console.log("Sandbox created\n");

// Install openclaw + bun in one shot
console.log("=== Installing openclaw + bun ===");
const installStart = performance.now();
await sandbox.runCommand("sh", [
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
console.log(`Installed in ${Math.round(performance.now() - installStart)}ms`);

// Find dist/entry.js
console.log("\n=== Inspecting entry point ===");
const entryInfo = await sandbox.runCommand("sh", [
  "-c",
  [
    `ls -la ${OPENCLAW_PKG_DIR}/dist/entry.* 2>/dev/null`,
    `echo "---"`,
    `head -30 ${OPENCLAW_PKG_DIR}/dist/entry.js 2>/dev/null || head -30 ${OPENCLAW_PKG_DIR}/dist/entry.mjs 2>/dev/null || echo "no entry file"`,
  ].join("\n"),
]);
console.log(await getStdout(entryInfo));

// Try bundling dist/entry.js
console.log("\n=== Bundling dist/entry.js ===");
const bundleStart = performance.now();
const bundleResult = await sandbox.runCommand("sh", [
  "-c",
  [
    `mkdir -p ${BUNDLE_DIR}`,
    `cd ${OPENCLAW_PKG_DIR}`,
    `${BUN_BIN} build ./dist/entry.js --target bun --outfile ${BUNDLE_ENTRY} ` +
      `--external node-llama-cpp --external ffmpeg-static --external electron ` +
      `--external "chromium-bidi/lib/cjs/bidiMapper/BidiMapper" ` +
      `--external "chromium-bidi/lib/cjs/cdp/CdpConnection" ` +
      `2>&1`,
    `echo "---"`,
    `ls -lh ${BUNDLE_ENTRY}`,
  ].join("\n"),
]);
const bundleOutput = await bundleResult.output("both");
console.log(bundleOutput.trim());
console.log(`Bundle in ${Math.round(performance.now() - bundleStart)}ms (exit: ${bundleResult.exitCode})`);

if (bundleResult.exitCode !== 0) {
  console.log("\nBundle failed. Let's check the entry.js structure more carefully.");
  const deeper = await sandbox.runCommand("sh", [
    "-c",
    [
      `cat ${OPENCLAW_PKG_DIR}/dist/entry.js 2>/dev/null || cat ${OPENCLAW_PKG_DIR}/dist/entry.mjs 2>/dev/null`,
    ].join("\n"),
  ]);
  console.log(await getStdout(deeper));

  // Try .mjs variant
  console.log("\n=== Trying entry.mjs ===");
  const bundleResult2 = await sandbox.runCommand("sh", [
    "-c",
    [
      `cd ${OPENCLAW_PKG_DIR}`,
      `${BUN_BIN} build ./dist/entry.mjs --target bun --outfile ${BUNDLE_ENTRY} ` +
        `--external node-llama-cpp --external ffmpeg-static --external electron ` +
        `--external "chromium-bidi/lib/cjs/bidiMapper/BidiMapper" ` +
        `--external "chromium-bidi/lib/cjs/cdp/CdpConnection" ` +
        `2>&1`,
      `echo "---"`,
      `ls -lh ${BUNDLE_ENTRY} 2>/dev/null || echo "no output"`,
    ].join("\n"),
  ]);
  console.log(await bundleResult2.output("both"));
}

// Copy necessary assets
console.log("\n=== Copying assets for bundle ===");
await sandbox.runCommand("sh", [
  "-c",
  [
    `cp ${OPENCLAW_PKG_DIR}/package.json ${BUNDLE_DIR}/`,
    `[ -d "${OPENCLAW_PKG_DIR}/dist/control-ui" ] && cp -r ${OPENCLAW_PKG_DIR}/dist/control-ui ${BUNDLE_DIR}/dist/ 2>/dev/null; true`,
    `[ -f "${OPENCLAW_PKG_DIR}/dist/babel.cjs" ] && cp ${OPENCLAW_PKG_DIR}/dist/babel.cjs ${BUNDLE_DIR}/dist/ 2>/dev/null; true`,
    // Copy canvas-host if exists
    `[ -d "${OPENCLAW_PKG_DIR}/dist/canvas-host" ] && cp -r ${OPENCLAW_PKG_DIR}/dist/canvas-host ${BUNDLE_DIR}/dist/ 2>/dev/null; true`,
    // Copy assets dir
    `[ -d "${OPENCLAW_PKG_DIR}/assets" ] && cp -r ${OPENCLAW_PKG_DIR}/assets ${BUNDLE_DIR}/ 2>/dev/null; true`,
    `echo "Bundle dir:"`,
    `du -sh ${BUNDLE_DIR}/`,
    `ls -la ${BUNDLE_DIR}/`,
  ].join("\n"),
]);

// Write config
await sandbox.runCommand("sh", [
  "-c",
  [
    `mkdir -p /home/vercel-sandbox/.openclaw`,
    `echo '{"gateway":{"mode":"local","auth":{"mode":"token"},"http":{"endpoints":{"chatCompletions":{"enabled":true}}}}}' > /home/vercel-sandbox/.openclaw/openclaw.json`,
    `echo 'test-token-123' > /home/vercel-sandbox/.openclaw/.gateway-token`,
    `echo '' > /home/vercel-sandbox/.openclaw/.ai-gateway-api-key`,
  ].join("\n"),
]);

// Benchmark
console.log("\n=== Benchmarking ===");
const ITERATIONS = 3;

async function benchmarkBoot(label, launchCmd) {
  const times = [];
  for (let i = 0; i < ITERATIONS; i++) {
    await sandbox.runCommand("sh", [
      "-c",
      "pkill -f 'openclaw' 2>/dev/null; pkill -f 'bun' 2>/dev/null; sleep 0.5",
    ]);

    const result = await sandbox.runCommand("sh", [
      "-c",
      [
        `_start=$(date +%s%N)`,
        `OPENCLAW_CONFIG_PATH=/home/vercel-sandbox/.openclaw/openclaw.json ` +
          `OPENCLAW_GATEWAY_TOKEN=test-token-123 ` +
          `${launchCmd} >> /tmp/bench.log 2>&1 &`,
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
      const logTail = await sandbox.runCommand("sh", ["-c", "tail -5 /tmp/bench.log 2>/dev/null"]);
      console.log(`  Log: ${(await getStdout(logTail)).slice(0, 200)}`);
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

// Bun normal
console.log("\nBun + openclaw (normal):");
const bunNormal = await benchmarkBoot(
  "bun-normal",
  `${BUN_BIN} ${OPENCLAW_BIN} gateway --port ${PORT} --bind loopback`,
);

// Bun bundle (if bundle was created)
const bundleExists = await sandbox.runCommand("sh", ["-c", `test -f ${BUNDLE_ENTRY} && echo yes || echo no`]);
const hasBundleFile = (await getStdout(bundleExists)) === "yes";

let bunBundled = [];
if (hasBundleFile) {
  console.log("\nBun + bundle:");
  bunBundled = await benchmarkBoot(
    "bun-bundle",
    `cd ${OPENCLAW_PKG_DIR} && ${BUN_BIN} ${BUNDLE_ENTRY} gateway --port ${PORT} --bind loopback`,
  );
} else {
  console.log("\nSkipping bundle benchmark (no bundle file).");
}

// Node baseline
console.log("\nNode + openclaw (baseline):");
const nodeNormal = await benchmarkBoot(
  "node",
  `${OPENCLAW_BIN} gateway --port ${PORT} --bind loopback`,
);

// Results
console.log("\n=== Results ===");
function summarize(label, times) {
  if (times.length === 0) { console.log(`${label}: all timed out`); return null; }
  const sorted = [...times].sort((a, b) => a - b);
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  console.log(`${label.padEnd(25)} avg=${avg}ms  min=${sorted[0]}ms  max=${sorted[sorted.length - 1]}ms  [${times.join(", ")}]`);
  return avg;
}

const nodeAvg = summarize("Node (baseline)", nodeNormal);
const bunAvg = summarize("Bun (normal)", bunNormal);
const bundleAvg = summarize("Bun (bundled)", bunBundled);

if (nodeAvg && bunAvg) {
  console.log(`\nBun vs Node: ${((1 - bunAvg / nodeAvg) * 100).toFixed(1)}% faster`);
}
if (bunAvg && bundleAvg) {
  console.log(`Bundle vs Bun: ${((1 - bundleAvg / bunAvg) * 100).toFixed(1)}% faster`);
}
if (nodeAvg && bundleAvg) {
  console.log(`Bundle vs Node: ${((1 - bundleAvg / nodeAvg) * 100).toFixed(1)}% faster`);
}

console.log("\nStopping sandbox...");
await sandbox.stop();
console.log("Done.");
