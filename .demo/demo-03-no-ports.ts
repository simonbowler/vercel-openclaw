/**
 * Demo 03: Create a sandbox WITHOUT ports and see if domain() still works.
 *
 * Tests whether v2 auto-detects ports or requires them at creation.
 */
import { Sandbox } from "@vercel/sandbox";
import { requireOidc } from "./lib/env.ts";

requireOidc();

async function main() {
  console.log("=== Demo 03: Create Sandbox Without Ports ===\n");

  // Create without ports param
  console.log("Creating sandbox WITHOUT ports param...");
  const sandbox = await Sandbox.create({
    timeout: 3 * 60 * 1000,
    resources: { vcpus: 1 },
  });

  console.log("✅ Created:");
  console.log(`  name:   ${sandbox.name}`);
  console.log(`  status: ${sandbox.status}`);

  // Check routes
  console.log(`\n--- Routes (no ports specified) ---`);
  const routes = sandbox.routes;
  console.log(`  routes count: ${routes.length}`);
  for (const r of routes) {
    console.log(`  port=${r.port} subdomain=${r.subdomain} url=${r.url}`);
  }

  // Try domain(3000)
  console.log(`\n--- domain(3000) without ports ---`);
  try {
    const url = sandbox.domain(3000);
    console.log(`  domain(3000) = ${url}`);
    console.log(`  ✅ domain() works even without ports in create!`);
  } catch (err: any) {
    console.log(`  ❌ domain(3000) threw: ${err.message}`);
    console.log(`  → Ports must be specified at creation time`);
  }

  // Start server and try anyway
  console.log(`\n--- Starting HTTP server on 3000 (detached) ---`);
  await sandbox.runCommand({
    cmd: "node",
    args: ["-e", `require("http").createServer((q,s)=>{s.writeHead(200);s.end("no-ports-test")}).listen(3000)`],
    detached: true,
  });
  await new Promise((r) => setTimeout(r, 2000));

  // Try fetching even if domain() worked — the URL might still 404
  try {
    const url = sandbox.domain(3000);
    console.log(`\n--- Fetching ${url} ---`);
    const resp = await fetch(url);
    const body = await resp.text();
    console.log(`  status: ${resp.status}`);
    console.log(`  body:   ${body.slice(0, 200)}`);
  } catch (err: any) {
    console.log(`  Fetch/domain failed: ${err.message}`);
  }

  // Cleanup
  console.log(`\n--- Stopping ---`);
  await sandbox.stop({ blocking: true });
  console.log("✅ Done.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
