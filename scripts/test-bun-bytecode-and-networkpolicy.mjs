#!/usr/bin/env node
/**
 * Test two sandbox optimizations locally:
 * 1. Bun bytecode bundle for gateway startup
 * 2. networkPolicy on Sandbox.create()
 */
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

async function run(sbx, cmd, args, timeout = 30000) {
  const r = await sbx.runCommand(cmd, args ?? []);
  return { exit: r.exitCode, out: (await r.output()).trim() };
}

// ============================================================
// TEST 1: networkPolicy on Sandbox.create()
// ============================================================
console.log("=== TEST 1: networkPolicy on Sandbox.create() ===");
try {
  const sbx = await Sandbox.create({
    ports: [3000],
    timeout: 60000,
    resources: { vcpus: 1 },
    networkPolicy: "allow-all",
  });
  console.log("networkPolicy='allow-all': OK — sandbox created:", sbx.sandboxId);
  await sbx.snapshot();
  console.log("PASS: networkPolicy on create works now!");
} catch (e) {
  console.log("FAIL:", e.message?.slice(0, 200));
  if (e.json) console.log("API:", JSON.stringify(e.json).slice(0, 200));
}

try {
  const sbx2 = await Sandbox.create({
    ports: [3000],
    timeout: 60000,
    resources: { vcpus: 1 },
    networkPolicy: { allow: ["api.openai.com", "ai-gateway.vercel.sh"] },
  });
  console.log("networkPolicy={allow:[...]}: OK — sandbox:", sbx2.sandboxId);
  await sbx2.snapshot();
  console.log("PASS: enforcing networkPolicy on create works!");
} catch (e) {
  console.log("FAIL:", e.message?.slice(0, 200));
  if (e.json) console.log("API:", JSON.stringify(e.json).slice(0, 200));
}

// ============================================================
// TEST 2: Bun bytecode bundle
// ============================================================
console.log("\n=== TEST 2: Bun bytecode bundle for gateway ===");

// Create a sandbox with openclaw installed + bun
const sbx = await Sandbox.create({
  ports: [3000],
  timeout: 5 * 60 * 1000,
  resources: { vcpus: 1 },
});
console.log("created sandbox:", sbx.sandboxId);

// Install openclaw
console.log("installing openclaw...");
const install = await run(sbx, "npm", ["install", "-g", "openclaw@latest", "--ignore-scripts"]);
console.log("install:", install.exit === 0 ? "OK" : "FAIL " + install.out.slice(-200));

// Install bun
console.log("installing bun...");
const bunInstall = await run(sbx, "sh", ["-c",
  "curl -fsSL --max-time 60 -o /tmp/bun.zip https://github.com/oven-sh/bun/releases/download/bun-v1.3.11/bun-linux-x64.zip && mkdir -p /home/vercel-sandbox/.bun/bin && unzip -o -j /tmp/bun.zip -d /home/vercel-sandbox/.bun/bin && chmod +x /home/vercel-sandbox/.bun/bin/bun && rm /tmp/bun.zip && /home/vercel-sandbox/.bun/bin/bun --version"
]);
console.log("bun:", bunInstall.exit === 0 ? "OK " + bunInstall.out : "FAIL");

// Find the gateway entrypoint
console.log("\nfinding gateway entrypoint...");
const entry = await run(sbx, "sh", ["-c",
  "cat /home/vercel-sandbox/.global/npm/lib/node_modules/openclaw/package.json | node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const p=JSON.parse(d);console.log(p.main||p.module||'openclaw.mjs')})\""
]);
console.log("entrypoint:", entry.out);

const entryPath = "/home/vercel-sandbox/.global/npm/lib/node_modules/openclaw/" + (entry.out || "openclaw.mjs");
console.log("full path:", entryPath);

// Try bun build --compile --bytecode
console.log("\nattempting bun build --compile --bytecode...");
const build = await run(sbx, "sh", ["-c",
  `/home/vercel-sandbox/.bun/bin/bun build --compile --bytecode ${entryPath} --outfile /home/vercel-sandbox/openclaw-compiled 2>&1 | tail -20`
]);
console.log("build exit:", build.exit);
console.log("build output:", build.out.slice(-500));

if (build.exit === 0) {
  // Check compiled binary size
  const size = await run(sbx, "ls", ["-lh", "/home/vercel-sandbox/openclaw-compiled"]);
  console.log("compiled binary:", size.out);

  // Try running it
  console.log("\ntesting compiled binary...");
  const testRun = await run(sbx, "sh", ["-c",
    "/home/vercel-sandbox/openclaw-compiled --version 2>&1 | head -5"
  ]);
  console.log("compiled --version:", testRun.exit, testRun.out);
} else {
  // Try just bun build (bundle without compile)
  console.log("\nattempting bun build --target bun (bundle only)...");
  const bundle = await run(sbx, "sh", ["-c",
    `/home/vercel-sandbox/.bun/bin/bun build --target bun ${entryPath} --outdir /home/vercel-sandbox/openclaw-bundle 2>&1 | tail -20`
  ]);
  console.log("bundle exit:", bundle.exit);
  console.log("bundle output:", bundle.out.slice(-500));

  if (bundle.exit === 0) {
    const size = await run(sbx, "sh", ["-c", "du -sh /home/vercel-sandbox/openclaw-bundle"]);
    console.log("bundle size:", size.out);

    // Try running the bundle
    console.log("\ntesting bundled entrypoint...");
    const testBundle = await run(sbx, "sh", ["-c",
      `/home/vercel-sandbox/.bun/bin/bun /home/vercel-sandbox/openclaw-bundle/openclaw.mjs --version 2>&1 | head -5`
    ]);
    console.log("bundle --version:", testBundle.exit, testBundle.out);
  }
}

// Benchmark: normal bun vs compiled/bundled
console.log("\n=== BENCHMARK: Normal Bun gateway startup ===");
const writeConfig = await run(sbx, "sh", ["-c",
  'mkdir -p /home/vercel-sandbox/.openclaw && echo \'{"gateway":{"mode":"local","auth":{"mode":"token"},"controlUi":{"dangerouslyDisableDeviceAuth":true}}}\' > /home/vercel-sandbox/.openclaw/openclaw.json && echo test-token > /home/vercel-sandbox/.openclaw/.gateway-token && echo "" > /home/vercel-sandbox/.openclaw/.ai-gateway-api-key'
]);

const normalBench = await run(sbx, "sh", ["-c", [
  "export OPENCLAW_CONFIG_PATH=/home/vercel-sandbox/.openclaw/openclaw.json",
  "export OPENCLAW_GATEWAY_TOKEN=test-token",
  "start=$(date +%s%N)",
  "setsid /home/vercel-sandbox/.bun/bin/bun /home/vercel-sandbox/.global/npm/bin/openclaw gateway --port 3000 --bind loopback >> /tmp/openclaw.log 2>&1 &",
  "attempts=0",
  "while [ $attempts -lt 120 ]; do",
  "  attempts=$((attempts+1))",
  "  if curl -s -f --max-time 1 http://localhost:3000/ 2>/dev/null | grep -q openclaw-app; then",
  "    end=$(date +%s%N)",
  "    echo \"normal_bun: $((  (end-start)/1000000 ))ms attempts=$attempts\"",
  "    break",
  "  fi",
  "  sleep 0.1",
  "done",
].join("\n")]);
console.log(normalBench.out);

await sbx.snapshot();
console.log("\ndone");
