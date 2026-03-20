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

// Use a snapshot with openclaw + bun
const SNAP = process.argv[2];
if (!SNAP) { console.error("Usage: node test-bun-external.mjs <snapshot-id>"); process.exit(1); }

const sbx = await Sandbox.create({
  source: { type: "snapshot", snapshotId: SNAP },
  ports: [3000, 3001],
  timeout: 5 * 60 * 1000,
  resources: { vcpus: 1 },
});
console.log("restored:", sbx.sandboxId);

async function run(sbx, cmd) {
  const r = await sbx.runCommand("sh", ["-c", cmd]);
  return { exit: r.exitCode, out: (await r.output()).trim() };
}

// Step 1: Try bun build with --external for the problematic dep
console.log("=== Step 1: bun build --compile with --external ===");
const entrypoint = "/home/vercel-sandbox/.global/npm/lib/node_modules/openclaw/dist/index.js";

// First, find ALL deps that might fail
console.log("finding problematic imports...");
const scan = await run(sbx,
  `/home/vercel-sandbox/.bun/bin/bun build --target bun ${entrypoint} --outdir /tmp/scan-test 2>&1 | grep "Could not resolve" | sort -u | head -20`
);
console.log("unresolvable deps:", scan.out || "(none)");

// Try with --external for each problematic dep
const externals = scan.out
  .split("\n")
  .map(line => {
    const m = line.match(/Could not resolve: "([^"]+)"/);
    return m ? m[1] : null;
  })
  .filter(Boolean);
console.log("externals to exclude:", externals);

if (externals.length > 0) {
  const externalFlags = externals.map(e => `--external ${e}`).join(" ");

  // Try bundle with externals
  console.log("\n=== Step 2: bun build --target bun with externals ===");
  const bundle = await run(sbx,
    `/home/vercel-sandbox/.bun/bin/bun build --target bun ${externalFlags} ${entrypoint} --outdir /tmp/oc-bundle 2>&1 | tail -10`
  );
  console.log("bundle:", bundle.exit, bundle.out.slice(-300));

  if (bundle.exit === 0) {
    const size = await run(sbx, "du -sh /tmp/oc-bundle && ls -lh /tmp/oc-bundle/ | head -5");
    console.log("bundle size:", size.out);

    // Try running the bundle
    console.log("\n=== Step 3: Test bundled gateway ===");
    await run(sbx, [
      'mkdir -p /home/vercel-sandbox/.openclaw',
      'echo \'{"gateway":{"mode":"local","auth":{"mode":"token"},"controlUi":{"dangerouslyDisableDeviceAuth":true}}}\' > /home/vercel-sandbox/.openclaw/openclaw.json',
      'echo test-token > /home/vercel-sandbox/.openclaw/.gateway-token',
      'echo "" > /home/vercel-sandbox/.openclaw/.ai-gateway-api-key',
    ].join(" && "));

    const testBundle = await run(sbx, [
      "export OPENCLAW_CONFIG_PATH=/home/vercel-sandbox/.openclaw/openclaw.json",
      "export OPENCLAW_GATEWAY_TOKEN=test-token",
      "start=$(date +%s%N)",
      "cd /home/vercel-sandbox/.global/npm/lib/node_modules/openclaw",
      "setsid /home/vercel-sandbox/.bun/bin/bun /tmp/oc-bundle/index.js gateway --port 3001 --bind loopback >> /tmp/oc-bundle.log 2>&1 &",
      "for i in $(seq 1 120); do",
      "  if curl -s -f --max-time 1 http://localhost:3001/ 2>/dev/null | grep -q openclaw-app; then",
      '    end=$(date +%s%N); echo "bundled: $((  (end-start)/1000000 ))ms attempts=$i"; break',
      "  fi; sleep 0.1",
      "done",
      "if [ $i -eq 120 ]; then echo 'TIMEOUT'; tail -20 /tmp/oc-bundle.log; fi",
    ].join("\n"));
    console.log("bundled result:", testBundle.out);

    // Compare with normal
    console.log("\n=== Step 4: Normal Bun baseline ===");
    await run(sbx, "pkill -f 'gateway.*3001' 2>/dev/null; sleep 1");
    const normalBench = await run(sbx, [
      "export OPENCLAW_CONFIG_PATH=/home/vercel-sandbox/.openclaw/openclaw.json",
      "export OPENCLAW_GATEWAY_TOKEN=test-token",
      "start=$(date +%s%N)",
      "setsid /home/vercel-sandbox/.bun/bin/bun /home/vercel-sandbox/.global/npm/bin/openclaw gateway --port 3001 --bind loopback >> /tmp/oc-normal.log 2>&1 &",
      "for i in $(seq 1 120); do",
      "  if curl -s -f --max-time 1 http://localhost:3001/ 2>/dev/null | grep -q openclaw-app; then",
      '    end=$(date +%s%N); echo "normal: $((  (end-start)/1000000 ))ms attempts=$i"; break',
      "  fi; sleep 0.1",
      "done",
    ].join("\n"));
    console.log("normal result:", normalBench.out);
  }

  // Also try --compile with externals
  console.log("\n=== Step 5: bun build --compile with externals ===");
  const compile = await run(sbx,
    `/home/vercel-sandbox/.bun/bin/bun build --compile ${externalFlags} ${entrypoint} --outfile /tmp/openclaw-compiled 2>&1 | tail -10`
  );
  console.log("compile:", compile.exit, compile.out.slice(-300));

  if (compile.exit === 0) {
    const size = await run(sbx, "ls -lh /tmp/openclaw-compiled");
    console.log("compiled binary:", size.out);

    const testCompiled = await run(sbx, "/tmp/openclaw-compiled --version 2>&1 | head -3");
    console.log("compiled --version:", testCompiled.out);
  }
}

await sbx.snapshot();
console.log("\ndone");
