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
if (!SNAP) { console.error("Usage: node test-readyz.mjs <snapshot-id>"); process.exit(1); }

const sbx = await Sandbox.create({
  source: { type: "snapshot", snapshotId: SNAP },
  ports: [3000],
  timeout: 5 * 60 * 1000,
  resources: { vcpus: 1 },
});
console.log("restored:", sbx.sandboxId);

// Write config and start gateway, then race probes — all in ONE runCommand
const script = `#!/bin/bash
set -euo pipefail
mkdir -p /home/vercel-sandbox/.openclaw
echo '{"gateway":{"mode":"local","auth":{"mode":"token"},"controlUi":{"dangerouslyDisableDeviceAuth":true}}}' > /home/vercel-sandbox/.openclaw/openclaw.json
echo test-token > /home/vercel-sandbox/.openclaw/.gateway-token
echo "" > /home/vercel-sandbox/.openclaw/.ai-gateway-api-key
export OPENCLAW_CONFIG_PATH=/home/vercel-sandbox/.openclaw/openclaw.json
export OPENCLAW_GATEWAY_TOKEN=test-token
setsid /home/vercel-sandbox/.bun/bin/bun /home/vercel-sandbox/.global/npm/bin/openclaw gateway --port 3000 --bind loopback >> /tmp/openclaw.log 2>&1 &
start_ns=$(date +%s%N)
root_ready=0; readyz_ready=0; healthz_ready=0
root_ms=0; readyz_ms=0; healthz_ms=0
root_att=0; readyz_att=0; healthz_att=0
for i in $(seq 1 300); do
  now_ns=$(date +%s%N)
  elapsed_ms=$(( (now_ns - start_ns) / 1000000 ))
  if [ $root_ready -eq 0 ]; then
    root_att=$((root_att+1))
    body=$(curl -s --max-time 1 http://localhost:3000/ 2>/dev/null || true)
    if echo "$body" | grep -q 'openclaw-app'; then
      root_ready=1; root_ms=$elapsed_ms
    fi
  fi
  if [ $readyz_ready -eq 0 ]; then
    readyz_att=$((readyz_att+1))
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 http://localhost:3000/readyz 2>/dev/null || echo 0)
    if [ "$code" = "200" ]; then
      readyz_ready=1; readyz_ms=$elapsed_ms
    fi
  fi
  if [ $healthz_ready -eq 0 ]; then
    healthz_att=$((healthz_att+1))
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 http://localhost:3000/healthz 2>/dev/null || echo 0)
    if [ "$code" = "200" ]; then
      healthz_ready=1; healthz_ms=$elapsed_ms
    fi
  fi
  if [ $root_ready -eq 1 ] && [ $readyz_ready -eq 1 ] && [ $healthz_ready -eq 1 ]; then
    break
  fi
  sleep 0.1
done
echo "/"
echo "  ready: $root_ready ms: $root_ms attempts: $root_att"
echo "/readyz"
echo "  ready: $readyz_ready ms: $readyz_ms attempts: $readyz_att"
echo "/healthz"
echo "  ready: $healthz_ready ms: $healthz_ms attempts: $healthz_att"
`;

await sbx.writeFiles([{ path: "/tmp/race-probes.sh", content: Buffer.from(script) }]);
await sbx.runCommand("chmod", ["+x", "/tmp/race-probes.sh"]);

console.log("\n=== Racing / vs /readyz vs /healthz ===");
const result = await sbx.runCommand("bash", ["/tmp/race-probes.sh"]);
console.log((await result.output()).trim());

await sbx.snapshot();
console.log("done");
