/**
 * Demo 06: persistent vs timeout behavior.
 *
 * Tests:
 * 1. persistent: true (default) — does it run indefinitely?
 * 2. persistent: false — what happens?
 * 3. persistent + timeout — do they coexist?
 * 4. extendTimeout still works?
 */
import { Sandbox } from "@vercel/sandbox";
import { requireOidc } from "./lib/env.ts";

requireOidc();

async function main() {
  console.log("=== Demo 06: Persistent vs Timeout ===\n");

  // Test 1: Default (persistent: true, no timeout)
  console.log("--- Test 1: Default (no persistent, no timeout) ---");
  const s1 = await Sandbox.create({
    ports: [3000],
    resources: { vcpus: 1 },
  });
  console.log(`  name:       ${s1.name}`);
  console.log(`  persistent: ${s1.persistent}`);
  console.log(`  timeout:    ${s1.timeout} ms`);
  console.log(`  status:     ${s1.status}`);
  await s1.stop({ blocking: true });

  // Test 2: persistent: false
  console.log("\n--- Test 2: persistent: false ---");
  const s2 = await Sandbox.create({
    persistent: false,
    ports: [3000],
    resources: { vcpus: 1 },
  });
  console.log(`  name:       ${s2.name}`);
  console.log(`  persistent: ${s2.persistent}`);
  console.log(`  timeout:    ${s2.timeout} ms`);
  console.log(`  status:     ${s2.status}`);
  await s2.stop({ blocking: true });

  // Test 3: persistent: true + explicit timeout
  console.log("\n--- Test 3: persistent: true + timeout: 60000 ---");
  const s3 = await Sandbox.create({
    persistent: true,
    timeout: 60_000,
    ports: [3000],
    resources: { vcpus: 1 },
  });
  console.log(`  name:       ${s3.name}`);
  console.log(`  persistent: ${s3.persistent}`);
  console.log(`  timeout:    ${s3.timeout} ms`);
  console.log(`  status:     ${s3.status}`);

  // Test 4: extendTimeout
  console.log("\n--- Test 4: extendTimeout(30000) ---");
  try {
    await s3.extendTimeout(30_000);
    console.log(`  timeout after extend: ${s3.timeout} ms`);
    console.log("  ✅ extendTimeout works");
  } catch (err: any) {
    console.log(`  ❌ extendTimeout failed: ${err.message}`);
  }
  await s3.stop({ blocking: true });

  // Test 5: persistent: false + timeout
  console.log("\n--- Test 5: persistent: false + timeout: 60000 ---");
  const s5 = await Sandbox.create({
    persistent: false,
    timeout: 60_000,
    ports: [3000],
    resources: { vcpus: 1 },
  });
  console.log(`  name:       ${s5.name}`);
  console.log(`  persistent: ${s5.persistent}`);
  console.log(`  timeout:    ${s5.timeout} ms`);
  await s5.stop({ blocking: true });

  console.log("\n✅ All persistent/timeout tests done.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
