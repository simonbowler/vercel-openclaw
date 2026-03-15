/**
 * Demo 09: Raw API endpoint probing.
 *
 * The v2 SDK uses /v1/sandboxes/named (new) instead of /v1/sandboxes (v1).
 * Let's check which endpoints exist and what they return.
 */
import { requireOidc } from "./lib/env.ts";

const token = requireOidc();

// Decode token to get teamId and projectId
const [, payload] = token.split(".");
const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
const teamId = decoded.owner_id;
const projectId = decoded.project_id;

async function probe(method: string, path: string, body?: object) {
  const url = new URL(path, "https://vercel.com");
  url.searchParams.set("teamId", teamId);

  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(url.toString(), opts);
  const text = await resp.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = null; }

  return { status: resp.status, json, text: text.slice(0, 500) };
}

async function main() {
  console.log("=== Demo 09: API Endpoint Probing ===\n");
  console.log(`teamId:    ${teamId}`);
  console.log(`projectId: ${projectId}\n`);

  // 1. GET /v1/sandboxes (v1 list endpoint)
  console.log("--- GET /v1/sandboxes (v1 list) ---");
  const r1 = await probe("GET", "/api/v1/sandboxes");
  console.log(`  status: ${r1.status}`);
  if (r1.json?.sandboxes) {
    console.log(`  sandboxes count: ${r1.json.sandboxes.length}`);
  } else {
    console.log(`  response: ${r1.text}`);
  }

  // 2. GET /v1/sandboxes/named (v2 list endpoint)
  console.log("\n--- GET /v1/sandboxes/named (v2 list) ---");
  const r2 = await probe("GET", "/api/v1/sandboxes/named");
  console.log(`  status: ${r2.status}`);
  if (r2.json?.sandboxes) {
    console.log(`  named sandboxes count: ${r2.json.sandboxes.length}`);
  } else {
    console.log(`  response: ${r2.text}`);
  }

  // 3. POST /v1/sandboxes/named (v2 create — just probe, don't actually create)
  // Actually let's try creating a minimal one to see the error
  console.log("\n--- POST /v1/sandboxes/named (v2 create) ---");
  const r3 = await probe("POST", "/api/v1/sandboxes/named", {
    projectId,
    ports: [3000],
    timeout: 60000,
  });
  console.log(`  status: ${r3.status}`);
  console.log(`  response: ${r3.text}`);

  // 4. POST /v1/sandboxes (v1 create — just probe)
  console.log("\n--- POST /v1/sandboxes (v1 create) ---");
  const r4 = await probe("POST", "/api/v1/sandboxes", {
    projectId,
    ports: [3000],
    timeout: 60000,
  });
  console.log(`  status: ${r4.status}`);
  if (r4.status === 200 || r4.status === 201) {
    console.log(`  ✅ v1 create works!`);
    console.log(`  sandboxId: ${r4.json?.sandbox?.id || r4.json?.id}`);
    // Stop it immediately
    const id = r4.json?.sandbox?.id || r4.json?.id;
    if (id) {
      console.log(`  Stopping ${id}...`);
      const stopResp = await probe("POST", `/api/v1/sandboxes/${id}/stop`);
      console.log(`  stop status: ${stopResp.status}`);
    }
  } else {
    console.log(`  response: ${r4.text}`);
  }

  // 5. Check /v2/sandboxes endpoint (used by sandbox.update())
  console.log("\n--- GET /v2/sandboxes (v2 update endpoint base) ---");
  const r5 = await probe("GET", "/api/v2/sandboxes");
  console.log(`  status: ${r5.status}`);
  console.log(`  response: ${r5.text}`);

  // 6. GET /v1/sandboxes/snapshots (snapshots list)
  console.log("\n--- GET /v1/sandboxes/snapshots ---");
  const r6 = await probe("GET", "/api/v1/sandboxes/snapshots");
  console.log(`  status: ${r6.status}`);
  if (r6.json?.snapshots) {
    console.log(`  snapshots count: ${r6.json.snapshots.length}`);
    for (const s of r6.json.snapshots.slice(0, 3)) {
      console.log(`  - ${s.id} (status=${s.status}, source=${s.sourceSandboxId})`);
    }
  } else {
    console.log(`  response: ${r6.text}`);
  }

  console.log("\n✅ Done.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
