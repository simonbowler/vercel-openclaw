#!/usr/bin/env node
/**
 * Experiment: Incremental timing of restore script components
 *
 * Restores a snapshot, installs openclaw+bun if needed, then
 * measures each layer of the startup script in isolation.
 *
 * Experiments (each run 5 times):
 *  1. Empty script baseline
 *  2. File writes only (mkdir + token + apikey)
 *  3. + config decode (base64)
 *  4. + setsid gateway (no wait)
 *  5. Full script with readiness loop
 *  6. Gateway only (no file writes) — snapshot has valid config
 *  7. Node instead of Bun
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

// Constants
const SNAPSHOT_ID = "snap_jjv8Xhiay8aifjNZZncJ6OCfIOtA";
const BUN = "/home/vercel-sandbox/.bun/bin/bun";
const OPENCLAW_BIN = "/home/vercel-sandbox/.global/npm/bin/openclaw";
const CONFIG_DIR = "/home/vercel-sandbox/.openclaw";
const CONFIG_PATH = `${CONFIG_DIR}/openclaw.json`;
const TOKEN_PATH = `${CONFIG_DIR}/.gateway-token`;
const API_KEY_PATH = `${CONFIG_DIR}/.ai-gateway-api-key`;
const PORT = 3000;
const ITERATIONS = 5;

const CONFIG_JSON = JSON.stringify({
  gateway: {
    mode: "local",
    auth: { mode: "token" },
    controlUi: { dangerouslyDisableDeviceAuth: true },
  },
});
const CONFIG_B64 = Buffer.from(CONFIG_JSON).toString("base64");

async function getOutput(result) {
  try {
    return (await result.output("stdout")).trim();
  } catch {
    try {
      return (await result.output()).trim();
    } catch {
      return "";
    }
  }
}

function stats(times) {
  const valid = times.filter((t) => t >= 0);
  if (valid.length === 0) return { min: -1, p50: -1, max: -1 };
  const sorted = [...valid].sort((a, b) => a - b);
  const p50idx = Math.ceil(valid.length / 2) - 1;
  return {
    min: sorted[0],
    p50: sorted[Math.max(0, p50idx)],
    max: sorted[sorted.length - 1],
  };
}

async function killGateway(sandbox) {
  await sandbox.runCommand("sh", [
    "-c",
    "pkill -9 -f 'openclaw' 2>/dev/null; pkill -9 -f 'bun.*gateway' 2>/dev/null; sleep 1; true",
  ]);
}

// ─── Restore the snapshot ───────────────────────────────────────────
console.log(`Restoring snapshot ${SNAPSHOT_ID}...`);
const restoreStart = performance.now();
const sandbox = await Sandbox.create({
  snapshot: SNAPSHOT_ID,
  ports: [PORT],
  timeout: 300_000,
  resources: { vcpus: 1 },
  env: {
    OPENCLAW_CONFIG_JSON_B64: CONFIG_B64,
  },
});
const restoreMs = Math.round(performance.now() - restoreStart);
console.log(`Sandbox restored in ${restoreMs}ms — id: ${sandbox.id}\n`);

// Check what's actually in the snapshot
console.log("=== Probing snapshot contents ===");
const probe = await sandbox.runCommand("sh", [
  "-c",
  [
    `echo "bun:"; ls -la ${BUN} 2>&1 || echo "NOT FOUND"`,
    `echo "openclaw:"; ls -la ${OPENCLAW_BIN} 2>&1 || echo "NOT FOUND"`,
    `echo "npm global:"; ls /home/vercel-sandbox/.global/npm/bin/ 2>&1 || echo "NOT FOUND"`,
    `echo "node:"; which node 2>&1; node --version 2>&1`,
    `echo "npm:"; which npm 2>&1`,
    `echo "home contents:"; ls -la /home/vercel-sandbox/ 2>&1`,
  ].join("\n"),
]);
console.log(await getOutput(probe));
console.log();

// Check if bun exists, if not install it
const bunCheck = await sandbox.runCommand("sh", ["-c", `test -f ${BUN} && echo yes || echo no`]);
const hasBun = (await getOutput(bunCheck)) === "yes";

const oclawCheck = await sandbox.runCommand("sh", ["-c", `test -f ${OPENCLAW_BIN} && echo yes || echo no`]);
const hasOclaw = (await getOutput(oclawCheck)) === "yes";

if (!hasOclaw) {
  console.log("Installing openclaw...");
  const installStart = performance.now();
  const installResult = await sandbox.runCommand("sh", [
    "-c",
    "npm install -g openclaw@latest --ignore-scripts 2>&1 | tail -5",
  ]);
  console.log(`openclaw installed in ${Math.round(performance.now() - installStart)}ms`);
  console.log(await getOutput(installResult));

  // Check where it went
  const whereResult = await sandbox.runCommand("sh", [
    "-c",
    "which openclaw 2>&1; ls -la $(which openclaw) 2>&1; npm root -g 2>&1",
  ]);
  console.log(`openclaw location: ${await getOutput(whereResult)}`);
}

if (!hasBun) {
  console.log("Installing bun...");
  const BUN_INSTALL_DIR = "/home/vercel-sandbox/.bun";
  const installStart = performance.now();
  await sandbox.runCommand("sh", [
    "-c",
    [
      `curl -fsSL --max-time 60 -o /tmp/bun.zip https://github.com/oven-sh/bun/releases/download/bun-v1.3.11/bun-linux-x64.zip`,
      `mkdir -p ${BUN_INSTALL_DIR}/bin`,
      `unzip -o -j /tmp/bun.zip -d ${BUN_INSTALL_DIR}/bin`,
      `chmod +x ${BUN}`,
      `rm -f /tmp/bun.zip`,
    ].join(" && "),
  ]);
  console.log(`bun installed in ${Math.round(performance.now() - installStart)}ms`);
}

// Re-check paths — find actual openclaw binary
let actualOpenclawBin = OPENCLAW_BIN;
const findOclaw = await sandbox.runCommand("sh", ["-c", "which openclaw 2>/dev/null || find / -name openclaw -type f 2>/dev/null | head -3"]);
const foundPath = (await getOutput(findOclaw)).split("\n")[0];
if (foundPath && foundPath.startsWith("/")) {
  actualOpenclawBin = foundPath;
  console.log(`Using openclaw at: ${actualOpenclawBin}`);
}

// Verify both work
const verify = await sandbox.runCommand("sh", [
  "-c",
  `${BUN} --version 2>&1; ${actualOpenclawBin} --version 2>&1 || echo "openclaw version check done"`,
]);
console.log(`Verify: ${await getOutput(verify)}\n`);

// Write config files once so ALL experiments have valid config
await sandbox.runCommand("sh", [
  "-c",
  [
    `mkdir -p ${CONFIG_DIR}`,
    `printf '%s' '${CONFIG_JSON}' > ${CONFIG_PATH}`,
    `printf '%s' 'test-token-123' > ${TOKEN_PATH}`,
    `printf '%s' 'test-api-key' > ${API_KEY_PATH}`,
  ].join(" && "),
]);
console.log("Config files written.");

// Quick diagnostic: can the gateway start?
console.log("\n=== Diagnostic: testing gateway launch ===");
const diagScript = [
  `export OPENCLAW_CONFIG_PATH=${CONFIG_PATH}`,
  `nohup ${BUN} ${actualOpenclawBin} gateway --port ${PORT} --bind loopback > /tmp/gw-diag.log 2>&1 &`,
  `GW_PID=$!`,
  `echo "Gateway PID: $GW_PID"`,
  `sleep 8`,
  `echo "Process alive:"; ps -p $GW_PID -o pid,comm 2>&1 || echo "DEAD"`,
  `echo "All openclaw:"; ps aux | grep -i openclaw | grep -v grep`,
  `echo "Curl:"; curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://localhost:${PORT}/ 2>&1`,
  `echo ""`,
  `echo "Log:"; cat /tmp/gw-diag.log 2>/dev/null | tail -30`,
].join("\n");
const diagResult = await sandbox.runCommand("sh", ["-c", diagScript]);
console.log(await getOutput(diagResult));
console.log();

const curlCheck2 = await sandbox.runCommand("sh", [
  "-c",
  `curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://localhost:${PORT}/ 2>&1`,
]);
const httpCode = (await getOutput(curlCheck2));
console.log(`Gateway HTTP status after 8s: ${httpCode}`);

if (httpCode !== "200") {
  console.log("\nGateway NOT ready after 8s. Trying longer wait...");
  // Wait up to 30s for first launch
  const waitResult = await sandbox.runCommand("sh", [
    "-c",
    [
      `for i in $(seq 1 60); do`,
      `  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 http://localhost:${PORT}/ 2>/dev/null)`,
      `  if [ "$CODE" = "200" ]; then echo "READY after ${"\u0024"}((i))x500ms"; exit 0; fi`,
      `  sleep 0.5`,
      `done`,
      `echo "TIMEOUT after 30s"`,
      `echo "Log tail:"; cat /tmp/gw-diag.log 2>/dev/null | tail -10`,
      `exit 1`,
    ].join("\n"),
  ]);
  console.log(await getOutput(waitResult));
}

await killGateway(sandbox);
console.log("\n");

// ─── Define experiments ─────────────────────────────────────────────

const GW_CMD_BUN = `OPENCLAW_CONFIG_PATH=${CONFIG_PATH} nohup ${BUN} ${actualOpenclawBin} gateway --port ${PORT} --bind loopback >/dev/null 2>&1 &`;
const GW_CMD_NODE = `OPENCLAW_CONFIG_PATH=${CONFIG_PATH} nohup ${actualOpenclawBin} gateway --port ${PORT} --bind loopback >/dev/null 2>&1 &`;

const READINESS_LOOP = [
  `for i in $(seq 1 300); do`,
  `  if curl -s -f --max-time 1 http://localhost:${PORT}/ 2>/dev/null | grep -q 'openclaw-app'; then`,
  `    exit 0`,
  `  fi`,
  `  sleep 0.1`,
  `done`,
  `exit 1`,
].join("\n");

const experiments = [
  {
    id: "#16",
    label: "Empty script (baseline)",
    needsKill: false,
    script: `exit 0`,
  },
  {
    id: "#17",
    label: "File writes only",
    needsKill: false,
    script: [
      `mkdir -p ${CONFIG_DIR}`,
      `printf '%s' 'test-token-123' > ${TOKEN_PATH}`,
      `printf '%s' 'test-api-key' > ${API_KEY_PATH}`,
    ].join(" && "),
  },
  {
    id: "#18",
    label: "+ config decode",
    needsKill: false,
    script: [
      `mkdir -p ${CONFIG_DIR}`,
      `printf '%s' 'test-token-123' > ${TOKEN_PATH}`,
      `printf '%s' 'test-api-key' > ${API_KEY_PATH}`,
      `printf '%s' '${CONFIG_B64}' | base64 -d > ${CONFIG_PATH}`,
    ].join(" && "),
  },
  {
    id: "#19",
    label: "+ setsid gateway (no wait)",
    needsKill: true,
    script: [
      `mkdir -p ${CONFIG_DIR}`,
      `printf '%s' 'test-token-123' > ${TOKEN_PATH}`,
      `printf '%s' 'test-api-key' > ${API_KEY_PATH}`,
      `printf '%s' '${CONFIG_B64}' | base64 -d > ${CONFIG_PATH}`,
      GW_CMD_BUN,
    ].join("\n"),
  },
  {
    id: "#20",
    label: "Full script + readiness",
    needsKill: true,
    script: [
      `mkdir -p ${CONFIG_DIR}`,
      `printf '%s' 'test-token-123' > ${TOKEN_PATH}`,
      `printf '%s' 'test-api-key' > ${API_KEY_PATH}`,
      `printf '%s' '${CONFIG_B64}' | base64 -d > ${CONFIG_PATH}`,
      GW_CMD_BUN,
      READINESS_LOOP,
    ].join("\n"),
  },
  {
    id: "#21",
    label: "Gateway only (no writes)",
    needsKill: true,
    script: [
      GW_CMD_BUN,
      READINESS_LOOP,
    ].join("\n"),
  },
  {
    id: "#22",
    label: "Node gateway + readiness",
    needsKill: true,
    script: [
      `mkdir -p ${CONFIG_DIR}`,
      `printf '%s' 'test-token-123' > ${TOKEN_PATH}`,
      `printf '%s' 'test-api-key' > ${API_KEY_PATH}`,
      `printf '%s' '${CONFIG_B64}' | base64 -d > ${CONFIG_PATH}`,
      GW_CMD_NODE,
      READINESS_LOOP,
    ].join("\n"),
  },
];

// ─── Run experiments ────────────────────────────────────────────────

const results = [];

for (const exp of experiments) {
  console.log(`\n=== ${exp.id}: ${exp.label} ===`);
  const times = [];

  for (let i = 0; i < ITERATIONS; i++) {
    if (exp.needsKill) {
      await killGateway(sandbox);
    }

    const start = performance.now();
    const result = await sandbox.runCommand("sh", ["-c", exp.script]);
    const elapsed = Math.round(performance.now() - start);
    const exitCode = result.exitCode;

    times.push(elapsed);

    if (exitCode !== 0 && exp.needsKill) {
      console.log(`  Run ${i + 1}: ${elapsed}ms (exit=${exitCode}) FAILED`);
      if (i === 0) {
        const diag = await sandbox.runCommand("sh", [
          "-c",
          `ps aux 2>/dev/null | grep -E 'openclaw|bun' | grep -v grep | head -5`,
        ]);
        console.log(`  Processes: ${(await getOutput(diag)).slice(0, 200)}`);
      }
    } else {
      console.log(`  Run ${i + 1}: ${elapsed}ms`);
    }
  }

  if (exp.needsKill) {
    await killGateway(sandbox);
  }

  const s = stats(times);
  results.push({ ...exp, times, stats: s });
  console.log(
    `  => min=${s.min}ms  p50=${s.p50}ms  max=${s.max}ms  raw=[${times.join(", ")}]`,
  );
}

// ─── Summary table ──────────────────────────────────────────────────

console.log("\n\n" + "=".repeat(90));
console.log("INCREMENTAL TIMING RESULTS");
console.log("=".repeat(90));
console.log(
  "Task   | Experiment                        | Min(ms) | P50(ms) | Max(ms) | Delta from prev",
);
console.log("-".repeat(90));

let prevP50 = 0;
for (const r of results) {
  const delta =
    prevP50 === 0
      ? "---"
      : `+${r.stats.p50 - prevP50}ms`;
  console.log(
    `${r.id.padEnd(6)} | ${r.label.padEnd(33)} | ${String(r.stats.min).padStart(7)} | ${String(r.stats.p50).padStart(7)} | ${String(r.stats.max).padStart(7)} | ${delta}`,
  );
  prevP50 = r.stats.p50;
}

console.log("-".repeat(90));

const baseline = results[0]?.stats.p50 || 0;
const fullBun = results[4]?.stats.p50 || 0;
const noWrites = results[5]?.stats.p50 || 0;
const nodeGw = results[6]?.stats.p50 || 0;

console.log("\nKEY FINDINGS:");
console.log(`  runCommand baseline (empty):      ${baseline}ms`);
console.log(`  Full Bun startup + readiness:     ${fullBun}ms`);
console.log(`  Gateway-only (no file writes):    ${noWrites}ms`);
console.log(`  Node gateway + readiness:         ${nodeGw}ms`);
if (fullBun > 0 && nodeGw > 0) {
  console.log(
    `  Bun vs Node saving:               ${nodeGw - fullBun}ms (${((1 - fullBun / nodeGw) * 100).toFixed(1)}% faster)`,
  );
}
if (fullBun > 0 && noWrites > 0) {
  console.log(
    `  File write overhead:              ${fullBun - noWrites}ms`,
  );
}
if (fullBun > 0 && baseline > 0) {
  console.log(
    `  Gateway boot time (Bun):          ${fullBun - baseline}ms (total minus baseline)`,
  );
}

console.log("\nStopping sandbox...");
await sandbox.stop();
console.log("Done.");
