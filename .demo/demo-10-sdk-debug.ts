/**
 * Demo 10: Run the SDK with DEBUG_FETCH=true to see exact requests.
 *
 * Also try creating via the SDK with explicit credentials to rule out
 * auth issues vs endpoint availability.
 */
import { Sandbox } from "@vercel/sandbox";
import { requireOidc } from "./lib/env.ts";

const token = requireOidc();

// Decode token
const [, payload] = token.split(".");
const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());

process.env.DEBUG_FETCH = "true";

async function main() {
  console.log("=== Demo 10: SDK Debug Mode ===\n");
  console.log(`teamId:    ${decoded.owner_id}`);
  console.log(`projectId: ${decoded.project_id}\n`);

  // Try with explicit credentials
  console.log("--- Attempt 1: SDK with auto credentials (OIDC) ---");
  try {
    const sandbox = await Sandbox.create({
      ports: [3000],
      timeout: 60_000,
    });
    console.log(`  ✅ Created: ${sandbox.name}`);
    await sandbox.stop({ blocking: true });
  } catch (err: any) {
    console.log(`  ❌ Failed: ${err.message}`);
    if (err.json) console.log(`  json: ${JSON.stringify(err.json)}`);
    if (err.response) console.log(`  url: ${err.response.url}`);
  }

  // Try with explicit token/teamId/projectId
  console.log("\n--- Attempt 2: SDK with explicit credentials ---");
  try {
    const sandbox = await Sandbox.create({
      ports: [3000],
      timeout: 60_000,
      token,
      projectId: decoded.project_id,
      teamId: decoded.owner_id,
    } as any);
    console.log(`  ✅ Created: ${sandbox.name}`);
    await sandbox.stop({ blocking: true });
  } catch (err: any) {
    console.log(`  ❌ Failed: ${err.message}`);
    if (err.json) console.log(`  json: ${JSON.stringify(err.json)}`);
    if (err.response) console.log(`  url: ${err.response.url}`);
  }

  // Try Sandbox.get with a fake name to see what error we get
  console.log("\n--- Attempt 3: Sandbox.get() with fake name ---");
  try {
    const sandbox = await Sandbox.get({ name: "nonexistent-sandbox" });
    console.log(`  ✅ Got: ${sandbox.name}`);
  } catch (err: any) {
    console.log(`  ❌ Failed: ${err.message}`);
    if (err.json) console.log(`  json: ${JSON.stringify(err.json)}`);
    if (err.response) console.log(`  url: ${err.response.url}`);
  }

  // Try the v1-style API: Sandbox.get with a sandboxId-looking name
  console.log("\n--- Attempt 4: Snapshot.list() ---");
  try {
    const { Snapshot } = await import("@vercel/sandbox");
    const result = await Snapshot.list();
    console.log(`  ✅ snapshots: ${result.json.snapshots.length}`);
  } catch (err: any) {
    console.log(`  ❌ Failed: ${err.message}`);
    if (err.json) console.log(`  json: ${JSON.stringify(err.json)}`);
    if (err.response) console.log(`  url: ${err.response.url}`);
  }

  console.log("\n✅ Done.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
