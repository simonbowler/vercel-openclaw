#!/usr/bin/env node
/**
 * spike-persistent-sandbox.mjs
 *
 * Validates 5 critical unknowns about @vercel/sandbox@beta persistent sandboxes.
 * Run manually — requires Vercel auth (vercel link + vercel env pull, or VERCEL_TOKEN).
 *
 * Usage:
 *   node scripts/spike-persistent-sandbox.mjs
 *
 * Each unknown is tested independently and results are printed at the end.
 */

import { Sandbox } from "@vercel/sandbox";

const SANDBOX_NAME = `spike-persistent-${Date.now()}`;
const TEST_FILE = "/tmp/spike-persistence-test.txt";
const TEST_CONTENT = `persistent-sandbox-spike-${Date.now()}`;

const results = {};

function record(unknown, answer, details) {
  results[unknown] = { answer, details };
  console.log(`  ${unknown}: ${answer} — ${details}`);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  let sandbox;

  try {
    // -----------------------------------------------------------------------
    // Step 1: Create a persistent sandbox with a name
    // -----------------------------------------------------------------------
    console.log("\n=== Creating persistent sandbox ===");
    sandbox = await Sandbox.create({
      name: SANDBOX_NAME,
      persistent: true,
      ports: [3000, 8787],
      timeout: 300_000, // 5 minutes
    });

    console.log(`  Created sandbox: name=${sandbox.name}`);
    console.log(`  persistent=${sandbox.persistent}`);
    console.log(`  status=${sandbox.status}`);

    // Check if sandboxId still exists (backwards compat)
    const hasSandboxId = "sandboxId" in sandbox;
    console.log(`  has sandboxId property=${hasSandboxId}`);
    if (hasSandboxId) {
      console.log(`  sandboxId=${sandbox.sandboxId}`);
    }

    // -----------------------------------------------------------------------
    // Step 2: Write a file to verify persistence later
    // -----------------------------------------------------------------------
    console.log("\n=== Writing test file ===");
    const writeResult = await sandbox.runCommand("bash", [
      "-c",
      `echo '${TEST_CONTENT}' > ${TEST_FILE}`,
    ]);
    console.log(`  Write exit code: ${writeResult.exitCode}`);

    // Verify write worked
    const readResult = await sandbox.runCommand("cat", [TEST_FILE]);
    const readOutput = await readResult.output("stdout");
    console.log(`  Read back: ${readOutput.trim()}`);

    // -----------------------------------------------------------------------
    // Unknown 5: Can we query currentSnapshotId?
    // -----------------------------------------------------------------------
    console.log("\n=== Unknown 5: currentSnapshotId ===");
    const snapshotIdBefore = sandbox.currentSnapshotId;
    console.log(`  currentSnapshotId (before stop): ${snapshotIdBefore}`);
    record(
      "Unknown 5",
      snapshotIdBefore !== undefined ? "YES" : "PROPERTY EXISTS BUT UNDEFINED",
      `currentSnapshotId = ${JSON.stringify(snapshotIdBefore)}`,
    );

    // Capture domain before stop for Unknown 3
    const domainBefore3000 = sandbox.domain(3000);
    const domainBefore8787 = sandbox.domain(8787);
    console.log(`\n=== Pre-stop domains ===`);
    console.log(`  domain(3000) = ${domainBefore3000}`);
    console.log(`  domain(8787) = ${domainBefore8787}`);

    // -----------------------------------------------------------------------
    // Step 3: Stop the sandbox
    // -----------------------------------------------------------------------
    console.log("\n=== Stopping sandbox ===");
    const stopResult = await sandbox.stop({ blocking: true });
    console.log(`  stop() returned:`, JSON.stringify(stopResult, null, 2));

    // -----------------------------------------------------------------------
    // Unknown 2: Does stop() expose snapshotId?
    // -----------------------------------------------------------------------
    console.log("\n=== Unknown 2: snapshotId in stop result ===");
    const stopHasSnapshot =
      stopResult &&
      typeof stopResult === "object" &&
      "snapshotId" in stopResult;
    const stopSnapshotId = stopHasSnapshot ? stopResult.snapshotId : undefined;
    // Also check currentSnapshotId on the sandbox object after stop
    const snapshotIdAfterStop = sandbox.currentSnapshotId;
    record(
      "Unknown 2",
      stopHasSnapshot ? "YES (in stop result)" : snapshotIdAfterStop ? "YES (via currentSnapshotId)" : "NO",
      `stop() result keys: ${stopResult ? Object.keys(stopResult).join(", ") : "null"}, ` +
        `currentSnapshotId after stop: ${JSON.stringify(snapshotIdAfterStop)}`,
    );

    // -----------------------------------------------------------------------
    // Unknown 1: Does get({ name }) error if sandbox doesn't exist?
    // -----------------------------------------------------------------------
    console.log("\n=== Unknown 1: get() with non-existent name ===");
    try {
      const ghost = await Sandbox.get({
        name: `nonexistent-${Date.now()}`,
      });
      record(
        "Unknown 1",
        "NO (returns sandbox)",
        `get() returned status=${ghost.status}, name=${ghost.name}`,
      );
      // Clean up if it somehow created one
      try {
        await ghost.delete();
      } catch {}
    } catch (err) {
      record(
        "Unknown 1",
        "YES (throws error)",
        `Error: ${err.message || err}`,
      );
    }

    // -----------------------------------------------------------------------
    // Step 4: Get the stopped sandbox by name — does it auto-resume?
    // -----------------------------------------------------------------------
    console.log("\n=== Getting sandbox by name (resume=true, default) ===");
    const resumed = await Sandbox.get({ name: SANDBOX_NAME });
    console.log(`  After get(): status=${resumed.status}`);
    console.log(`  persistent=${resumed.persistent}`);

    // -----------------------------------------------------------------------
    // Step 5: Verify file persistence
    // -----------------------------------------------------------------------
    console.log("\n=== Verifying file persistence ===");
    const verifyResult = await resumed.runCommand("cat", [TEST_FILE]);
    const verifyOutput = await verifyResult.output("stdout");
    const filePreserved = verifyOutput.trim() === TEST_CONTENT;
    console.log(`  File content: ${verifyOutput.trim()}`);
    console.log(`  File preserved: ${filePreserved}`);

    // -----------------------------------------------------------------------
    // Unknown 3: Do port domains stay stable across sessions?
    // -----------------------------------------------------------------------
    console.log("\n=== Unknown 3: Domain stability ===");
    const domainAfter3000 = resumed.domain(3000);
    const domainAfter8787 = resumed.domain(8787);
    console.log(`  domain(3000) before: ${domainBefore3000}`);
    console.log(`  domain(3000) after:  ${domainAfter3000}`);
    console.log(`  domain(8787) before: ${domainBefore8787}`);
    console.log(`  domain(8787) after:  ${domainAfter8787}`);
    const domainsStable =
      domainBefore3000 === domainAfter3000 &&
      domainBefore8787 === domainAfter8787;
    record(
      "Unknown 3",
      domainsStable ? "YES (stable)" : "NO (changed)",
      `3000: ${domainBefore3000} → ${domainAfter3000}, ` +
        `8787: ${domainBefore8787} → ${domainAfter8787}`,
    );

    // -----------------------------------------------------------------------
    // Unknown 4: Does extendTimeout() still work?
    // -----------------------------------------------------------------------
    console.log("\n=== Unknown 4: extendTimeout() ===");
    try {
      await resumed.extendTimeout(60_000);
      record("Unknown 4", "YES (works)", "extendTimeout(60000) succeeded");
    } catch (err) {
      record(
        "Unknown 4",
        "NO (throws)",
        `Error: ${err.message || err}`,
      );
    }

    // -----------------------------------------------------------------------
    // Also check: Sandbox.get with resume=false
    // -----------------------------------------------------------------------
    console.log("\n=== Bonus: get() with resume=false ===");
    await resumed.stop({ blocking: true });
    try {
      const noResume = await Sandbox.get({
        name: SANDBOX_NAME,
        resume: false,
      });
      console.log(`  resume=false: status=${noResume.status}`);
      console.log(
        `  (sandbox stays stopped, no new session created)`,
      );
      // Use this handle for cleanup
      sandbox = noResume;
    } catch (err) {
      console.log(`  resume=false threw: ${err.message || err}`);
    }

    // -----------------------------------------------------------------------
    // Also check: listSessions and listSnapshots
    // -----------------------------------------------------------------------
    console.log("\n=== Bonus: listSessions / listSnapshots ===");
    try {
      const sessionsResult = await resumed.listSessions();
      console.log(`  Sessions count: ${sessionsResult.sessions.length}`);
      for (const s of sessionsResult.sessions.slice(0, 3)) {
        console.log(`    session ${s.id}: status=${s.status}`);
      }
    } catch (err) {
      console.log(`  listSessions error: ${err.message || err}`);
    }
    try {
      const snapshotsResult = await resumed.listSnapshots();
      console.log(`  Snapshots count: ${snapshotsResult.snapshots.length}`);
      for (const s of snapshotsResult.snapshots.slice(0, 3)) {
        console.log(
          `    snapshot ${s.id}: status=${s.status}, size=${s.sizeBytes}`,
        );
      }
    } catch (err) {
      console.log(`  listSnapshots error: ${err.message || err}`);
    }

    // -----------------------------------------------------------------------
    // Also check: update() method
    // -----------------------------------------------------------------------
    console.log("\n=== Bonus: update() method ===");
    try {
      // Try to get a running sandbox for update test
      const forUpdate = await Sandbox.get({ name: SANDBOX_NAME });
      await forUpdate.update({ tags: { spike: "test" } });
      console.log(`  update({ tags }) succeeded`);
      console.log(`  tags after update: ${JSON.stringify(forUpdate.tags)}`);
      sandbox = forUpdate; // use for cleanup
    } catch (err) {
      console.log(`  update() error: ${err.message || err}`);
    }
  } catch (err) {
    console.error("\n!!! Unexpected error:", err);
  } finally {
    // -----------------------------------------------------------------------
    // Cleanup
    // -----------------------------------------------------------------------
    console.log("\n=== Cleanup ===");
    try {
      // Try to get the sandbox for deletion
      const toDelete = await Sandbox.get({
        name: SANDBOX_NAME,
        resume: false,
      }).catch(() => sandbox);
      if (toDelete) {
        await toDelete.delete();
        console.log(`  Deleted sandbox ${SANDBOX_NAME}`);
      }
    } catch (err) {
      console.log(`  Cleanup error: ${err.message || err}`);
      console.log(`  Manual cleanup may be needed for: ${SANDBOX_NAME}`);
    }

    // -----------------------------------------------------------------------
    // Summary
    // -----------------------------------------------------------------------
    console.log("\n" + "=".repeat(70));
    console.log("RESULTS SUMMARY");
    console.log("=".repeat(70));
    for (const [key, val] of Object.entries(results)) {
      console.log(`${key}: ${val.answer}`);
      console.log(`  → ${val.details}`);
    }
    console.log("=".repeat(70));
  }
}

main();
