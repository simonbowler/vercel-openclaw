/**
 * Demo 11: Verify v1 SDK still works with our credentials.
 *
 * Uses the parent project's v1.8.1 to confirm the problem is
 * specifically the v2 /named endpoint, not our auth.
 */
import { requireOidc } from "./lib/env.ts";

// We can't import v1 from here (we have v2 installed).
// Instead, test the v1 endpoint directly.

const token = requireOidc();
const [, payload] = token.split(".");
const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
const teamId = decoded.owner_id;
const projectId = decoded.project_id;

async function main() {
  console.log("=== Demo 11: v1 API Endpoint Test ===\n");

  // v1 create uses POST /v1/sandboxes (not /v1/sandboxes/named)
  console.log("--- POST /api/v1/sandboxes (v1 create) ---");
  const resp = await fetch(
    `https://vercel.com/api/v1/sandboxes?teamId=${teamId}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        projectId,
        ports: [3000],
        timeout: 60_000,
        resources: { vcpus: 1 },
      }),
    },
  );

  const text = await resp.text();
  console.log(`  status: ${resp.status}`);

  if (resp.ok) {
    const json = JSON.parse(text);
    const sandboxId = json.sandbox?.id || json.id;
    console.log(`  ✅ v1 create works! sandboxId: ${sandboxId}`);

    // Check routes
    if (json.routes) {
      console.log(`  routes: ${JSON.stringify(json.routes)}`);
    }

    // Get domain
    if (json.routes?.length > 0) {
      const route = json.routes.find((r: any) => r.port === 3000);
      if (route) {
        console.log(`  domain for 3000: https://${route.subdomain}.vercel.run`);
      }
    }

    // Stop it
    console.log(`  Stopping...`);
    const stopResp = await fetch(
      `https://vercel.com/api/v1/sandboxes/${sandboxId}/stop?teamId=${teamId}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    console.log(`  stop status: ${stopResp.status}`);
  } else {
    console.log(`  ❌ v1 create failed: ${text}`);
  }

  // Also try v1 list
  console.log("\n--- GET /api/v1/sandboxes (v1 list) ---");
  const listResp = await fetch(
    `https://vercel.com/api/v1/sandboxes?teamId=${teamId}&projectId=${projectId}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  console.log(`  status: ${listResp.status}`);
  if (listResp.ok) {
    const json = await listResp.json() as any;
    console.log(`  ✅ v1 list works! sandboxes: ${json.sandboxes?.length}`);
  } else {
    const text = await listResp.text();
    console.log(`  ❌ ${text}`);
  }

  console.log("\n✅ Done.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
