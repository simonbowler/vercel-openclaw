/**
 * Demo 05: Sandbox.get() with v2 `name` param.
 *
 * Tests:
 * 1. Create with explicit name, then Sandbox.get({ name })
 * 2. Whether a v1 sandboxId works as a v2 name
 */
import { Sandbox } from "@vercel/sandbox";
import { requireOidc } from "./lib/env.ts";

requireOidc();

const V1_SANDBOX_ID = process.argv[2]; // Optional: pass a v1 sandboxId

async function main() {
  console.log("=== Demo 05: Sandbox.get() by Name ===\n");

  // 1. Create with explicit name
  const testName = `demo-get-test-${Date.now()}`;
  console.log(`1. Creating sandbox with name: ${testName}`);
  const sandbox = await Sandbox.create({
    name: testName,
    ports: [3000],
    timeout: 5 * 60 * 1000,
    resources: { vcpus: 1 },
  });
  console.log(`   created: ${sandbox.name}`);
  console.log(`   status:  ${sandbox.status}`);

  // 2. Get by name
  console.log(`\n2. Sandbox.get({ name: "${testName}" })`);
  const fetched = await Sandbox.get({ name: testName });
  console.log(`   fetched name:   ${fetched.name}`);
  console.log(`   fetched status: ${fetched.status}`);
  console.log(`   routes: ${JSON.stringify(fetched.routes)}`);

  // 3. Verify domain works on fetched sandbox
  console.log("\n3. Starting server and checking domain on fetched sandbox...");
  await fetched.runCommand({
    cmd: "node",
    args: ["-e", `require("http").createServer((q,s)=>{s.writeHead(200);s.end("fetched-by-name")}).listen(3000)`],
    detached: true,
  });
  await new Promise((r) => setTimeout(r, 2000));

  try {
    const url = fetched.domain(3000);
    console.log(`   domain(3000) = ${url}`);
    const resp = await fetch(url);
    const body = await resp.text();
    console.log(`   status: ${resp.status}, body: ${body}`);
    if (resp.status === 200) {
      console.log("   ✅ Sandbox.get() + domain() works!");
    }
  } catch (err: any) {
    console.log(`   ❌ Failed: ${err.message}`);
  }

  // Cleanup
  await sandbox.stop({ blocking: true });

  // 4. Try v1 sandboxId as v2 name (optional)
  if (V1_SANDBOX_ID) {
    console.log(`\n--- Part B: v1 sandboxId as v2 name ---`);
    console.log(`Trying Sandbox.get({ name: "${V1_SANDBOX_ID}" })`);
    try {
      const v1 = await Sandbox.get({ name: V1_SANDBOX_ID });
      console.log(`  name:   ${v1.name}`);
      console.log(`  status: ${v1.status}`);
      console.log(`  routes: ${JSON.stringify(v1.routes)}`);
      console.log("  ✅ v1 sandboxId works as v2 name!");
    } catch (err: any) {
      console.log(`  ❌ Failed: ${err.message}`);
      console.log("  → v1 sandboxIds are NOT valid v2 names");
    }
  }

  console.log("\n✅ Done.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
