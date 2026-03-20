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

// Use existing snapshot with openclaw + bun
const SNAP = process.argv[2];
if (!SNAP) { console.error("Usage: node test-bun-bundle-only.mjs <snapshot-id>"); process.exit(1); }

async function run(sbx, cmd, args) {
  const r = await sbx.runCommand(cmd, args ?? []);
  return { exit: r.exitCode, out: (await r.output()).trim() };
}

const sbx = await Sandbox.create({
  source: { type: "snapshot", snapshotId: SNAP },
  ports: [3000, 3001],
  timeout: 5 * 60 * 1000,
  resources: { vcpus: 1 },
});
console.log("restored:", sbx.sandboxId);

// Write minimal config
await run(sbx, "sh", ["-c",
  'mkdir -p /home/vercel-sandbox/.openclaw && echo \'{"gateway":{"mode":"local","auth":{"mode":"token"},"controlUi":{"dangerouslyDisableDeviceAuth":true}}}\' > /home/vercel-sandbox/.openclaw/openclaw.json && echo test-token > /home/vercel-sandbox/.openclaw/.gateway-token && echo "" > /home/vercel-sandbox/.openclaw/.ai-gateway-api-key'
]);

// Try bun build --target bun (no --compile, just bundle)
console.log("=== Bun bundle (no compile) ===");
const bundle = await run(sbx, "sh", ["-c",
  "/home/vercel-sandbox/.bun/bin/bun build --target bun /home/vercel-sandbox/.global/npm/lib/node_modules/openclaw/dist/index.js --outdir /tmp/oc-bundle 2>&1 | tail -10"
]);
console.log("bundle:", bundle.exit, bundle.out.slice(-300));

if (bundle.exit === 0) {
  const size = await run(sbx, "sh", ["-c", "du -sh /tmp/oc-bundle && ls -lh /tmp/oc-bundle/ | head -10"]);
  console.log("size:", size.out);
}

// Benchmark 1: Normal Bun startup
console.log("\n=== Benchmark 1: Normal Bun ===");
const b1 = await run(sbx, "sh", ["-c", [
  "export OPENCLAW_CONFIG_PATH=/home/vercel-sandbox/.openclaw/openclaw.json",
  "export OPENCLAW_GATEWAY_TOKEN=test-token",
  "start=$(date +%s%N)",
  "setsid /home/vercel-sandbox/.bun/bin/bun /home/vercel-sandbox/.global/npm/bin/openclaw gateway --port 3000 --bind loopback >> /tmp/oc1.log 2>&1 &",
  "for i in $(seq 1 120); do",
  "  if curl -s -f --max-time 1 http://localhost:3000/ 2>/dev/null | grep -q openclaw-app; then",
  "    end=$(date +%s%N); echo \"normal: $((  (end-start)/1000000 ))ms attempts=$i\"; break",
  "  fi; sleep 0.1",
  "done",
].join("\n")]);
console.log(b1.out);

// Kill gateway 1
await run(sbx, "sh", ["-c", "pkill -f 'openclaw gateway' 2>/dev/null; sleep 1"]);

// Benchmark 2: Try running the entrypoint directly (skip npm shim)
console.log("\n=== Benchmark 2: Direct entrypoint (skip npm shim) ===");
const b2 = await run(sbx, "sh", ["-c", [
  "export OPENCLAW_CONFIG_PATH=/home/vercel-sandbox/.openclaw/openclaw.json",
  "export OPENCLAW_GATEWAY_TOKEN=test-token",
  "start=$(date +%s%N)",
  "cd /home/vercel-sandbox/.global/npm/lib/node_modules/openclaw",
  "setsid /home/vercel-sandbox/.bun/bin/bun ./dist/entry.js gateway --port 3001 --bind loopback >> /tmp/oc2.log 2>&1 &",
  "for i in $(seq 1 120); do",
  "  if curl -s -f --max-time 1 http://localhost:3001/ 2>/dev/null | grep -q openclaw-app; then",
  "    end=$(date +%s%N); echo \"direct: $((  (end-start)/1000000 ))ms attempts=$i\"; break",
  "  fi; sleep 0.1",
  "done",
].join("\n")]);
console.log(b2.out);

// Try /readyz and /healthz endpoints
console.log("\n=== Test /readyz and /healthz ===");
const readyz = await run(sbx, "sh", ["-c", "curl -s http://localhost:3001/readyz 2>&1 | head -c 200"]);
console.log("/readyz:", readyz.exit, readyz.out.slice(0, 200));
const healthz = await run(sbx, "sh", ["-c", "curl -s http://localhost:3001/healthz 2>&1 | head -c 200"]);
console.log("/healthz:", healthz.exit, healthz.out.slice(0, 200));

await sbx.snapshot();
console.log("done");
