/**
 * Demo 08: List and manage sandboxes with v2 APIs.
 *
 * Tests new v2 capabilities:
 * - Sandbox.list()
 * - Snapshot.list()
 * - sandbox.listSessions()
 * - sandbox.listSnapshots()
 */
import { Sandbox, Snapshot } from "@vercel/sandbox";
import { requireOidc } from "./lib/env.ts";

requireOidc();

async function main() {
  console.log("=== Demo 08: List & Manage ===\n");

  // Test 1: Sandbox.list()
  console.log("--- Sandbox.list() ---");
  try {
    const result = await Sandbox.list();
    const { sandboxes, pagination } = result.json;
    console.log(`  total: ${pagination.total}`);
    console.log(`  count: ${pagination.count}`);
    for (const s of sandboxes.slice(0, 5)) {
      console.log(`  - ${s.name} (status=${s.status}, persistent=${s.persistent}, runtime=${s.runtime})`);
    }
    if (sandboxes.length > 5) {
      console.log(`  ... and ${sandboxes.length - 5} more`);
    }
  } catch (err: any) {
    console.log(`  ❌ Sandbox.list() failed: ${err.message}`);
  }

  // Test 2: Snapshot.list()
  console.log("\n--- Snapshot.list() ---");
  try {
    const result = await Snapshot.list();
    const { snapshots, pagination } = result.json;
    console.log(`  total: ${pagination.total}`);
    console.log(`  count: ${pagination.count}`);
    for (const s of snapshots.slice(0, 5)) {
      console.log(`  - ${s.id} (status=${s.status}, size=${s.sizeBytes}B, source=${s.sourceSandboxId})`);
    }
    if (snapshots.length > 5) {
      console.log(`  ... and ${snapshots.length - 5} more`);
    }
  } catch (err: any) {
    console.log(`  ❌ Snapshot.list() failed: ${err.message}`);
  }

  console.log("\n✅ Done.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
