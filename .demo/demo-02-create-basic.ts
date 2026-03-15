/**
 * Demo 02: Create a basic v2 sandbox with ports and verify domain() works.
 *
 * This is the core gap — in our previous attempt, domain(3000) returned
 * URLs that 404'd. Let's isolate whether it's a creation issue or a
 * domain resolution issue.
 */
import { Sandbox } from "@vercel/sandbox";
import { requireOidc } from "./lib/env.ts";

requireOidc();

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

async function main() {
  console.log("=== Demo 02: Create Basic Sandbox ===\n");

  // Step 1: Create with ports (same as v1 pattern)
  console.log("Creating sandbox with ports: [3000]...");
  const sandbox = await Sandbox.create({
    ports: [3000],
    timeout: TIMEOUT_MS,
    resources: { vcpus: 1 },
  });

  console.log("✅ Created sandbox:");
  console.log(`  name:       ${sandbox.name}`);
  console.log(`  persistent: ${sandbox.persistent}`);
  console.log(`  region:     ${sandbox.region}`);
  console.log(`  runtime:    ${sandbox.runtime}`);
  console.log(`  vcpus:      ${sandbox.vcpus}`);
  console.log(`  memory:     ${sandbox.memory} MB`);
  console.log(`  timeout:    ${sandbox.timeout} ms`);
  console.log(`  status:     ${sandbox.status}`);

  // Step 2: Check routes
  console.log(`\n--- Routes ---`);
  const routes = sandbox.routes;
  console.log(`  routes count: ${routes.length}`);
  for (const r of routes) {
    console.log(`  port=${r.port} subdomain=${r.subdomain} url=${r.url}`);
  }

  // Step 3: Check domain(3000)
  console.log(`\n--- domain(3000) ---`);
  try {
    const url = sandbox.domain(3000);
    console.log(`  domain(3000) = ${url}`);

    // Step 4: Start a simple HTTP server and fetch the domain
    console.log(`\n--- Starting HTTP server on port 3000 ---`);
    const cmd = await sandbox.runCommand("node", [
      "-e",
      `require("http").createServer((req, res) => { res.writeHead(200); res.end("hello from v2 sandbox"); }).listen(3000, () => console.log("listening on 3000"))`,
    ]);
    // That will block, so use detached mode instead
  } catch (err) {
    console.log(`  ❌ domain(3000) threw: ${err}`);
  }

  // Step 4b: Use detached command for the HTTP server
  console.log(`\n--- Starting HTTP server (detached) on port 3000 ---`);
  const server = await sandbox.runCommand({
    cmd: "node",
    args: [
      "-e",
      `require("http").createServer((req, res) => { res.writeHead(200, {"content-type":"text/plain"}); res.end("hello from v2 sandbox"); }).listen(3000, () => console.log("listening on 3000"))`,
    ],
    detached: true,
  });
  console.log(`  server command id: ${server.cmdId}`);

  // Wait for it to start
  await new Promise((r) => setTimeout(r, 2000));

  // Step 5: Fetch the domain URL
  const domainUrl = sandbox.domain(3000);
  console.log(`\n--- Fetching ${domainUrl} ---`);
  try {
    const resp = await fetch(domainUrl, {
      headers: { "User-Agent": "sandbox-v2-demo" },
    });
    const body = await resp.text();
    console.log(`  status: ${resp.status}`);
    console.log(`  body:   ${body.slice(0, 200)}`);
    if (resp.status === 200 && body.includes("hello from v2")) {
      console.log(`  ✅ Port routing works!`);
    } else {
      console.log(`  ⚠️  Unexpected response — port routing may have issues`);
    }
  } catch (err) {
    console.log(`  ❌ Fetch failed: ${err}`);
  }

  // Step 6: Also try without ports in create and see what happens
  console.log(`\n--- Session info ---`);
  const session = sandbox.currentSession();
  console.log(`  sessionId: ${session.sessionId}`);
  console.log(`  status:    ${session.status}`);
  console.log(`  runtime:   ${session.runtime}`);

  // Cleanup
  console.log(`\n--- Stopping sandbox ---`);
  await sandbox.stop({ blocking: true });
  console.log("✅ Stopped.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
