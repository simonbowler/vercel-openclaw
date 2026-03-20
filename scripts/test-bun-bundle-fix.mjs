#!/usr/bin/env node
import { readFileSync } from "node:fs";
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
const SNAP = process.argv[2];
if (!SNAP) { console.error("Usage: node test-bun-bundle-fix.mjs <snapshot-id>"); process.exit(1); }

const sbx = await Sandbox.create({
  source: { type: "snapshot", snapshotId: SNAP },
  ports: [3000],
  timeout: 5 * 60 * 1000,
  resources: { vcpus: 1 },
});
console.log("restored:", sbx.sandboxId);

async function run(cmd) {
  const r = await sbx.runCommand("sh", ["-c", cmd]);
  return { exit: r.exitCode, out: (await r.output()).trim() };
}

const BUN = "/home/vercel-sandbox/.bun/bin/bun";
const PKG = "/home/vercel-sandbox/.global/npm/lib/node_modules/openclaw";
const entry = `${PKG}/dist/index.js`;
const externals = "node-llama-cpp ffmpeg-static electron chromium-bidi/lib/cjs/bidiMapper/BidiMapper chromium-bidi/lib/cjs/cdp/CdpConnection";
const exFlags = externals.split(" ").map(e => `--external "${e}"`).join(" ");

// Build the bundle
console.log("=== Building bundle ===");
const build = await run(`rm -rf /tmp/oc-final && ${BUN} build --target bun ${exFlags} ${entry} --outdir /tmp/oc-final 2>&1 | tail -5`);
console.log("build:", build.exit === 0 ? "OK" : "FAIL", build.out.slice(-200));

// Copy package.json and any other runtime-required files
console.log("\n=== Copying runtime assets ===");
await run(`cp ${PKG}/package.json /tmp/oc-final/`);
// Copy skills, assets, and other dirs the gateway reads at runtime
await run(`cp -r ${PKG}/assets /tmp/oc-final/ 2>/dev/null; cp -r ${PKG}/skills /tmp/oc-final/ 2>/dev/null; cp -r ${PKG}/extensions /tmp/oc-final/ 2>/dev/null; cp -r ${PKG}/docs /tmp/oc-final/ 2>/dev/null; true`);
const size = await run("du -sh /tmp/oc-final");
console.log("total bundle size:", size.out);

// Write config
await run([
  'mkdir -p /home/vercel-sandbox/.openclaw',
  'echo \'{"gateway":{"mode":"local","auth":{"mode":"token"},"controlUi":{"dangerouslyDisableDeviceAuth":true}}}\' > /home/vercel-sandbox/.openclaw/openclaw.json',
  'echo test-token > /home/vercel-sandbox/.openclaw/.gateway-token',
  'echo "" > /home/vercel-sandbox/.openclaw/.ai-gateway-api-key',
].join(" && "));

// Benchmark: bundled
console.log("\n=== Benchmark: Bundled (with package.json + assets) ===");
const bundled = await run([
  "export OPENCLAW_CONFIG_PATH=/home/vercel-sandbox/.openclaw/openclaw.json",
  "export OPENCLAW_GATEWAY_TOKEN=test-token",
  "start=$(date +%s%N)",
  "cd /tmp/oc-final",
  `setsid ${BUN} /tmp/oc-final/index.js gateway --port 3000 --bind loopback >> /tmp/oc-bundled.log 2>&1 &`,
  "for i in $(seq 1 120); do",
  "  if curl -s -f --max-time 1 http://localhost:3000/ 2>/dev/null | grep -q openclaw-app; then",
  '    end=$(date +%s%N); echo "bundled: $(( (end-start)/1000000 ))ms attempts=$i"; exit 0',
  "  fi; sleep 0.1",
  "done",
  "echo TIMEOUT; tail -30 /tmp/oc-bundled.log",
].join("\n"));
console.log(bundled.out);

// Kill and benchmark normal
await run("pkill -f 'gateway.*3000' 2>/dev/null; sleep 2");

console.log("\n=== Benchmark: Normal Bun ===");
const normal = await run([
  "export OPENCLAW_CONFIG_PATH=/home/vercel-sandbox/.openclaw/openclaw.json",
  "export OPENCLAW_GATEWAY_TOKEN=test-token",
  "start=$(date +%s%N)",
  `setsid ${BUN} ${PKG}/../../../bin/openclaw gateway --port 3000 --bind loopback >> /tmp/oc-normal.log 2>&1 &`,
  "for i in $(seq 1 120); do",
  "  if curl -s -f --max-time 1 http://localhost:3000/ 2>/dev/null | grep -q openclaw-app; then",
  '    end=$(date +%s%N); echo "normal: $(( (end-start)/1000000 ))ms attempts=$i"; exit 0',
  "  fi; sleep 0.1",
  "done",
  "echo TIMEOUT",
].join("\n"));
console.log(normal.out);

await sbx.snapshot();
console.log("\ndone");
