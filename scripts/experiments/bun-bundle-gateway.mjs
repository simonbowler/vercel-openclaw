/**
 * Experiment: Test Bun bundle as gateway launcher
 *
 * Restores from snapshot, builds a Bun bundle of openclaw,
 * copies runtime assets, then benchmarks bundled boot vs normal boot.
 * If bundled is faster, snapshots and tests restore of the bundled version.
 *
 * Uses in-sandbox curl loop for timing.
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

const SNAPSHOT_ID = "snap_jjv8Xhiay8aifjNZZncJ6OCfIOtA";
const CYCLES = 5;
const BUN_PATH = "/home/vercel-sandbox/.bun/bin/bun";
const OPENCLAW_BIN = "/home/vercel-sandbox/.global/npm/bin/openclaw";
const OPENCLAW_PKG_DIR =
  "/home/vercel-sandbox/.global/npm/lib/node_modules/openclaw";
const BUNDLE_DIR = "/tmp/oc-bundle";
const GATEWAY_CONFIG = JSON.stringify({
  gateway: {
    mode: "local",
    auth: { mode: "token" },
    controlUi: { dangerouslyDisableDeviceAuth: true },
  },
});
const GATEWAY_TOKEN = "test-token";

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

const BOOT_SCRIPT_TEMPLATE = (launcher) => `
#!/bin/bash
set -e

# Kill any existing gateway
pkill -f "openclaw gateway" 2>/dev/null || true
pkill -f "oc-bundle" 2>/dev/null || true
sleep 0.5

START_NS=$(date +%s%N)

# Launch gateway
${launcher} &
GW_PID=$!

# Poll for readiness
READY=0
for i in $(seq 1 120); do
  if curl -sf http://localhost:3000/ > /dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.5
done

END_NS=$(date +%s%N)
ELAPSED_MS=$(( (END_NS - START_NS) / 1000000 ))

if [ "$READY" = "1" ]; then
  echo "READY_MS=$ELAPSED_MS"
else
  echo "TIMEOUT"
fi

kill $GW_PID 2>/dev/null || true
wait $GW_PID 2>/dev/null || true
`;

async function writeConfig(sandbox) {
  await sandbox.runCommand("sh", [
    "-c",
    `mkdir -p /home/vercel-sandbox/.openclaw && echo '${GATEWAY_CONFIG}' > /home/vercel-sandbox/.openclaw/openclaw.json && echo '${GATEWAY_TOKEN}' > /home/vercel-sandbox/.openclaw/.gateway-token`,
  ]);
}

async function measureBoot(sandbox, label, launcher) {
  const script = BOOT_SCRIPT_TEMPLATE(launcher);
  await sandbox.runCommand("sh", [
    "-c",
    `cat > /tmp/boot-test.sh << 'SCRIPT'\n${script}\nSCRIPT\nchmod +x /tmp/boot-test.sh`,
  ]);

  const cmdStart = performance.now();
  const result = await sandbox.runCommand("bash", ["/tmp/boot-test.sh"]);
  const cmdMs = Math.round(performance.now() - cmdStart);

  const output = (await result.output() || "").trim();
  const readyLine = output.split("\n").find((l) => l.startsWith("READY_MS="));
  const timedOut = output.includes("TIMEOUT");

  let inSandboxMs = null;
  if (readyLine) {
    inSandboxMs = parseInt(readyLine.split("=")[1], 10);
  }

  console.log(
    `  ${label}: runCmd=${cmdMs}ms | in-sandbox=${timedOut ? "TIMEOUT" : inSandboxMs + "ms"}`,
  );
  if (output.length < 5) {
    console.log(`  raw output: ${JSON.stringify(output)}`);
  }

  return { cmdMs, inSandboxMs, timedOut };
}

// ==================== PHASE 1: Build the bundle ====================
console.log("Phase 1: Restore sandbox and build Bun bundle...\n");

const buildSandbox = await Sandbox.create({
  snapshot: SNAPSHOT_ID,
  ports: [3000],
  timeout: 120_000,
  resources: { vcpus: 2 }, // use 2 vCPU for faster bundling
});
console.log(`Build sandbox: ${buildSandbox.id}`);

await writeConfig(buildSandbox);

// Build the bundle
console.log("Building Bun bundle...");
const bundleStart = performance.now();
const bundleResult = await buildSandbox.runCommand("sh", [
  "-c",
  `${BUN_PATH} build --target bun --external node-llama-cpp --external ffmpeg-static --external electron --external "chromium-bidi/lib/cjs/bidiMapper/BidiMapper" --external "chromium-bidi/lib/cjs/cdp/CdpConnection" ${OPENCLAW_PKG_DIR}/dist/index.js --outdir ${BUNDLE_DIR} 2>&1`,
]);
const bundleMs = Math.round(performance.now() - bundleStart);
console.log(`Bundle built in ${bundleMs}ms`);
const bundleOutput = await bundleResult.output();
console.log(`Bundle output: ${(bundleOutput || "").trim()}`);
if (bundleResult.exitCode !== 0) {
  console.error(`Bundle failed! output: ${bundleOutput}`);
  await buildSandbox.stop();
  process.exit(1);
}

// Copy runtime assets
console.log("Copying runtime assets...");
const copyResult = await buildSandbox.runCommand("sh", [
  "-c",
  `cp ${OPENCLAW_PKG_DIR}/package.json ${BUNDLE_DIR}/ && cp -r ${OPENCLAW_PKG_DIR}/dist/control-ui ${BUNDLE_DIR}/ 2>/dev/null; cp ${OPENCLAW_PKG_DIR}/dist/babel.cjs ${BUNDLE_DIR}/ 2>/dev/null; ls -la ${BUNDLE_DIR}/`,
]);
console.log(`Assets: ${(await copyResult.output() || "").trim()}`);

// Check bundle size vs original
const sizeResult = await buildSandbox.runCommand("sh", [
  "-c",
  `echo "Bundle:" && du -sh ${BUNDLE_DIR}/ && echo "Original:" && du -sh ${OPENCLAW_PKG_DIR}/`,
]);
console.log(`Sizes:\n${(await sizeResult.output() || "").trim()}`);

// ==================== PHASE 2: Benchmark normal vs bundled ====================
console.log("\n\nPhase 2: Benchmark normal vs bundled boot...\n");

const normalLauncher = `${BUN_PATH} ${OPENCLAW_BIN} gateway --config /home/vercel-sandbox/.openclaw/openclaw.json`;
const bundleLauncher = `${BUN_PATH} ${BUNDLE_DIR}/index.js gateway --config /home/vercel-sandbox/.openclaw/openclaw.json`;

const normalResults = [];
const bundledResults = [];

for (let i = 0; i < CYCLES; i++) {
  console.log(`\n--- Cycle ${i + 1}/${CYCLES} ---`);

  // Normal boot
  const normal = await measureBoot(buildSandbox, "Normal ", normalLauncher);
  normalResults.push(normal);

  // Wait a moment between tests
  await buildSandbox.runCommand("sleep", ["1"]);

  // Bundled boot
  const bundled = await measureBoot(buildSandbox, "Bundled", bundleLauncher);
  bundledResults.push(bundled);

  await buildSandbox.runCommand("sleep", ["1"]);
}

// ==================== PHASE 3: If bundled is faster, snapshot and test restore ====================
const normalInSandbox = normalResults
  .filter((r) => r.inSandboxMs !== null)
  .map((r) => r.inSandboxMs);
const bundledInSandbox = bundledResults
  .filter((r) => r.inSandboxMs !== null)
  .map((r) => r.inSandboxMs);

const normalP50 =
  normalInSandbox.length > 0
    ? percentile(
        [...normalInSandbox].sort((a, b) => a - b),
        50,
      )
    : Infinity;
const bundledP50 =
  bundledInSandbox.length > 0
    ? percentile(
        [...bundledInSandbox].sort((a, b) => a - b),
        50,
      )
    : Infinity;

let snapshotRestoreResults = null;

if (bundledP50 < normalP50) {
  console.log(
    `\n\nPhase 3: Bundled is faster (${bundledP50}ms vs ${normalP50}ms). Snapshotting and testing restore...`,
  );

  // Snapshot the bundled sandbox
  const snapStart = performance.now();
  const snapshot = await buildSandbox.snapshot();
  const snapMs = Math.round(performance.now() - snapStart);
  console.log(`Snapshot created: ${snapshot.id} in ${snapMs}ms`);

  // Test restoring from the bundled snapshot
  snapshotRestoreResults = [];
  for (let i = 0; i < CYCLES; i++) {
    console.log(`\n--- Restore cycle ${i + 1}/${CYCLES} ---`);

    const restoreStart = performance.now();
    const restored = await Sandbox.create({
      snapshot: snapshot.id,
      ports: [3000],
      timeout: 120_000,
      resources: { vcpus: 1 },
    });
    const restoreMs = Math.round(performance.now() - restoreStart);

    await writeConfig(restored);
    const r = await measureBoot(restored, "Bundled-restore", bundleLauncher);
    snapshotRestoreResults.push({ restoreMs, ...r });

    await restored.stop();
  }
} else {
  console.log(
    `\n\nPhase 3: Skipped — bundled not faster (bundled p50=${bundledP50}ms vs normal p50=${normalP50}ms)`,
  );
}

await buildSandbox.stop();

// ==================== REPORT ====================
console.log("\n\n========== RESULTS ==========\n");

console.log("--- Normal boot (in-sandbox readiness) ---");
if (normalInSandbox.length > 0) {
  console.log(`  ${JSON.stringify(stats(normalInSandbox))}`);
  console.log(`  Raw: [${normalInSandbox.join(", ")}]`);
} else {
  console.log("  All timed out");
}

console.log("\n--- Bundled boot (in-sandbox readiness) ---");
if (bundledInSandbox.length > 0) {
  console.log(`  ${JSON.stringify(stats(bundledInSandbox))}`);
  console.log(`  Raw: [${bundledInSandbox.join(", ")}]`);
} else {
  console.log("  All timed out");
}

const normalCmd = normalResults
  .filter((r) => r.cmdMs !== null)
  .map((r) => r.cmdMs);
const bundledCmd = bundledResults
  .filter((r) => r.cmdMs !== null)
  .map((r) => r.cmdMs);
console.log("\n--- Normal boot (runCommand time) ---");
if (normalCmd.length > 0) {
  console.log(`  ${JSON.stringify(stats(normalCmd))}`);
  console.log(`  Raw: [${normalCmd.join(", ")}]`);
}
console.log("\n--- Bundled boot (runCommand time) ---");
if (bundledCmd.length > 0) {
  console.log(`  ${JSON.stringify(stats(bundledCmd))}`);
  console.log(`  Raw: [${bundledCmd.join(", ")}]`);
}

if (snapshotRestoreResults) {
  const restoreTimes = snapshotRestoreResults.map((r) => r.restoreMs);
  const restoreInSandbox = snapshotRestoreResults
    .filter((r) => r.inSandboxMs !== null)
    .map((r) => r.inSandboxMs);
  console.log("\n--- Bundled snapshot restore ---");
  console.log(`  Restore time: ${JSON.stringify(stats(restoreTimes))}`);
  console.log(`  Raw restore: [${restoreTimes.join(", ")}]`);
  if (restoreInSandbox.length > 0) {
    console.log(
      `  In-sandbox readiness: ${JSON.stringify(stats(restoreInSandbox))}`,
    );
    console.log(`  Raw readiness: [${restoreInSandbox.join(", ")}]`);
  }
}

console.log("\nDelta: bundled p50 vs normal p50:");
if (bundledP50 !== Infinity && normalP50 !== Infinity) {
  const delta = bundledP50 - normalP50;
  console.log(
    `  ${delta > 0 ? "+" : ""}${delta}ms (${delta < 0 ? "bundled faster" : delta > 0 ? "normal faster" : "same"})`,
  );
} else {
  console.log("  Insufficient data");
}

console.log("\nDone.");
