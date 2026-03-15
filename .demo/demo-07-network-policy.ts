/**
 * Demo 07: NetworkPolicy v2 format.
 *
 * Tests the new v2 network policy format including:
 * - "allow-all" / "deny-all" strings
 * - { allow: string[] } (simple list)
 * - { allow: Record<string, Rule[]> } (with transform/header injection)
 * - subnets
 * - updateNetworkPolicy (deprecated) vs update()
 */
import { Sandbox } from "@vercel/sandbox";
import { requireOidc } from "./lib/env.ts";

requireOidc();

async function main() {
  console.log("=== Demo 07: Network Policy V2 ===\n");

  // Create sandbox
  console.log("Creating sandbox with networkPolicy: 'allow-all'...");
  const sandbox = await Sandbox.create({
    ports: [3000],
    timeout: 5 * 60 * 1000,
    resources: { vcpus: 1 },
    networkPolicy: "allow-all",
  });
  console.log(`  name: ${sandbox.name}`);
  console.log(`  networkPolicy: ${JSON.stringify(sandbox.networkPolicy)}`);

  // Test 1: Simple allow list via update()
  console.log("\n--- Test 1: update() with simple allow list ---");
  try {
    await sandbox.update({
      networkPolicy: {
        allow: ["*.npmjs.org", "github.com", "registry.npmjs.org"],
      },
    });
    console.log(`  ✅ update() succeeded`);
    console.log(`  networkPolicy: ${JSON.stringify(sandbox.networkPolicy)}`);
  } catch (err: any) {
    console.log(`  ❌ update() failed: ${err.message}`);
  }

  // Test 2: Record form with transform
  console.log("\n--- Test 2: update() with record form + transforms ---");
  try {
    await sandbox.update({
      networkPolicy: {
        allow: {
          "ai-gateway.vercel.sh": [{
            transform: [{
              headers: { authorization: "Bearer test-token" },
            }],
          }],
          "*.npmjs.org": [],
          "*": [],
        },
      },
    });
    console.log(`  ✅ update() with transforms succeeded`);
    console.log(`  networkPolicy: ${JSON.stringify(sandbox.networkPolicy)}`);
  } catch (err: any) {
    console.log(`  ❌ update() failed: ${err.message}`);
  }

  // Test 3: deny-all
  console.log("\n--- Test 3: deny-all ---");
  try {
    await sandbox.update({ networkPolicy: "deny-all" });
    console.log(`  ✅ deny-all succeeded`);
    console.log(`  networkPolicy: ${JSON.stringify(sandbox.networkPolicy)}`);
  } catch (err: any) {
    console.log(`  ❌ deny-all failed: ${err.message}`);
  }

  // Test 4: Deprecated updateNetworkPolicy
  console.log("\n--- Test 4: deprecated updateNetworkPolicy() ---");
  try {
    const result = await sandbox.updateNetworkPolicy("allow-all");
    console.log(`  ✅ updateNetworkPolicy() still works`);
    console.log(`  returned: ${JSON.stringify(result)}`);
  } catch (err: any) {
    console.log(`  ❌ updateNetworkPolicy() failed: ${err.message}`);
  }

  // Test 5: Session-level update
  console.log("\n--- Test 5: session.update({ networkPolicy }) ---");
  try {
    const session = sandbox.currentSession();
    await session.update({
      networkPolicy: { allow: ["example.com"] },
    });
    console.log(`  ✅ session.update() succeeded`);
    console.log(`  session networkPolicy: ${JSON.stringify(session.networkPolicy)}`);
  } catch (err: any) {
    console.log(`  ❌ session.update() failed: ${err.message}`);
  }

  // Cleanup
  await sandbox.stop({ blocking: true });
  console.log("\n✅ All network policy tests done.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
