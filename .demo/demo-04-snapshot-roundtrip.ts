/**
 * Demo 04: Full snapshot roundtrip — create, write state, snapshot, restore.
 *
 * Tests whether v2 snapshots + port routing work end-to-end.
 * Also tests if a v1 snapshot can be restored via v2 (if ID provided).
 */
import { Sandbox, Snapshot } from "@vercel/sandbox";
import { requireOidc } from "./lib/env.ts";

requireOidc();

const V1_SNAPSHOT_ID = process.argv[2]; // Optional: pass a v1 snapshotId as arg

async function main() {
  console.log("=== Demo 04: Snapshot Roundtrip ===\n");

  // ---- Part A: v2 → v2 snapshot roundtrip ----
  console.log("--- Part A: v2-to-v2 snapshot roundtrip ---\n");

  // 1. Create sandbox with ports
  console.log("1. Creating sandbox with ports: [3000]...");
  const sandbox = await Sandbox.create({
    ports: [3000],
    timeout: 5 * 60 * 1000,
    resources: { vcpus: 1 },
  });
  console.log(`   name: ${sandbox.name}`);

  // 2. Write a marker file
  console.log("2. Writing marker file...");
  await sandbox.writeFiles([
    { path: "/tmp/snapshot-marker.txt", content: Buffer.from("v2-demo-marker-" + Date.now()) },
  ]);
  const check = await sandbox.runCommand("cat", ["/tmp/snapshot-marker.txt"]);
  console.log(`   marker: ${await check.output()}`);

  // 3. Start HTTP server
  console.log("3. Starting HTTP server (detached)...");
  await sandbox.runCommand({
    cmd: "node",
    args: ["-e", `require("http").createServer((q,s)=>{s.writeHead(200);s.end("pre-snapshot")}).listen(3000)`],
    detached: true,
  });
  await new Promise((r) => setTimeout(r, 2000));

  // 4. Verify server works
  const domain1 = sandbox.domain(3000);
  console.log(`4. domain(3000) = ${domain1}`);
  try {
    const resp = await fetch(domain1);
    console.log(`   fetch status: ${resp.status}, body: ${await resp.text()}`);
  } catch (err: any) {
    console.log(`   ❌ fetch failed: ${err.message}`);
  }

  // 5. Snapshot (stops the sandbox)
  console.log("5. Creating snapshot (this stops the sandbox)...");
  const snap = await sandbox.snapshot();
  console.log(`   snapshotId:      ${snap.snapshotId}`);
  console.log(`   sourceSandboxId: ${snap.sourceSandboxId}`);
  console.log(`   sizeBytes:       ${snap.sizeBytes}`);
  console.log(`   status:          ${snap.status}`);
  console.log(`   createdAt:       ${snap.createdAt}`);

  // 6. Restore from snapshot
  console.log("\n6. Restoring from v2 snapshot...");
  const restored = await Sandbox.create({
    source: { type: "snapshot", snapshotId: snap.snapshotId },
    ports: [3000],
    timeout: 5 * 60 * 1000,
  });
  console.log(`   name:   ${restored.name}`);
  console.log(`   status: ${restored.status}`);

  // 7. Check routes on restored sandbox
  console.log("7. Routes on restored sandbox:");
  for (const r of restored.routes) {
    console.log(`   port=${r.port} subdomain=${r.subdomain} url=${r.url}`);
  }

  // 8. Check marker file survived
  console.log("8. Checking marker file...");
  const markerCheck = await restored.runCommand("cat", ["/tmp/snapshot-marker.txt"]);
  console.log(`   marker: ${await markerCheck.output()}`);
  console.log(`   exitCode: ${markerCheck.exitCode}`);

  // 9. Start HTTP server on restored sandbox
  console.log("9. Starting HTTP server on restored sandbox...");
  await restored.runCommand({
    cmd: "node",
    args: ["-e", `require("http").createServer((q,s)=>{s.writeHead(200);s.end("post-snapshot")}).listen(3000)`],
    detached: true,
  });
  await new Promise((r) => setTimeout(r, 2000));

  // 10. Fetch from restored sandbox
  const domain2 = restored.domain(3000);
  console.log(`10. domain(3000) on restored = ${domain2}`);
  try {
    const resp = await fetch(domain2);
    const body = await resp.text();
    console.log(`    fetch status: ${resp.status}, body: ${body}`);
    if (resp.status === 200) {
      console.log("    ✅ v2 snapshot roundtrip works!");
    }
  } catch (err: any) {
    console.log(`    ❌ fetch failed: ${err.message}`);
  }

  // Cleanup restored
  console.log("\n--- Cleaning up restored sandbox ---");
  await restored.stop({ blocking: true });

  // ---- Part B: v1 snapshot → v2 restore (optional) ----
  if (V1_SNAPSHOT_ID) {
    console.log(`\n--- Part B: v1 snapshot restore ---`);
    console.log(`Restoring v1 snapshot: ${V1_SNAPSHOT_ID}`);

    try {
      const v1Restored = await Sandbox.create({
        source: { type: "snapshot", snapshotId: V1_SNAPSHOT_ID },
        ports: [3000],
        timeout: 5 * 60 * 1000,
      });
      console.log(`  name:   ${v1Restored.name}`);
      console.log(`  status: ${v1Restored.status}`);
      console.log(`  routes: ${JSON.stringify(v1Restored.routes)}`);

      const domain3 = v1Restored.domain(3000);
      console.log(`  domain(3000) = ${domain3}`);

      const resp = await fetch(domain3);
      console.log(`  fetch status: ${resp.status}`);
      const body = await resp.text();
      console.log(`  body: ${body.slice(0, 200)}`);

      await v1Restored.stop({ blocking: true });
      console.log("  ✅ v1 snapshot restore works with v2 SDK!");
    } catch (err: any) {
      console.log(`  ❌ v1 snapshot restore failed: ${err.message}`);
    }
  } else {
    console.log("\n--- Skipping Part B (no v1 snapshot ID provided) ---");
    console.log("   Run with: npx tsx demo-04-snapshot-roundtrip.ts <snapshotId>");
  }

  // Cleanup snapshot
  console.log("\n--- Deleting test snapshot ---");
  await snap.delete();
  console.log("✅ All done.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
