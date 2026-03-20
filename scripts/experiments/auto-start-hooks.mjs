#!/usr/bin/env node
/**
 * Experiment: Auto-start hook paths
 *
 * Tests which hook paths are auto-executed on snapshot restore.
 * Uses runCommand to write files (writeFiles has permission issues on system paths).
 *
 * NOTE: Prior experiments found /tmp and /vercel/sandbox/ do NOT survive
 * snapshot/restore. This experiment verifies that and tests all paths anyway.
 *
 * Also tests Sandbox.create({ env }) for passing config at create/restore time.
 */

import { readFileSync } from "node:fs";

// Load OIDC credentials from .env.local
const content = readFileSync(
  new URL("../../.env.local", import.meta.url),
  "utf-8",
);
for (const line of content.split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq === -1) continue;
  const k = t.slice(0, eq);
  let v = t.slice(eq + 1);
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  if (!process.env[k]) process.env[k] = v;
}

const { Sandbox } = await import("@vercel/sandbox");

function ms(start) {
  return Math.round(performance.now() - start);
}

async function getOutput(result) {
  try { return (await result.output("stdout")).trim(); } catch { return ""; }
}

async function getBothOutput(result) {
  try { return (await result.output("both")).trim(); } catch { return ""; }
}

const HOOK_PATHS = [
  {
    label: "/vercel/sandbox/.on-restore.sh",
    path: "/vercel/sandbox/.on-restore.sh",
    resultFile: "/tmp/hook-result-on-restore.txt",
  },
  {
    label: "/home/vercel-sandbox/.on-restore.sh",
    path: "/home/vercel-sandbox/.on-restore.sh",
    resultFile: "/tmp/hook-result-home-on-restore.txt",
  },
  {
    label: "/etc/rc.local",
    path: "/etc/rc.local",
    resultFile: "/tmp/hook-result-rc-local.txt",
  },
  {
    label: "/root/.profile",
    path: "/root/.profile",
    resultFile: "/tmp/hook-result-profile.txt",
  },
  {
    label: "/vercel/sandbox/init.d/start.sh",
    path: "/vercel/sandbox/init.d/start.sh",
    resultFile: "/tmp/hook-result-initd.txt",
    mkdirParent: "/vercel/sandbox/init.d",
  },
  {
    label: "/root/.bashrc",
    path: "/root/.bashrc",
    resultFile: "/tmp/hook-result-bashrc.txt",
  },
  {
    label: "/vercel/sandbox/.on-start.sh",
    path: "/vercel/sandbox/.on-start.sh",
    resultFile: "/tmp/hook-result-on-start.txt",
  },
  {
    label: "/home/vercel-sandbox/.on-start.sh",
    path: "/home/vercel-sandbox/.on-start.sh",
    resultFile: "/tmp/hook-result-home-on-start.txt",
  },
];

const results = [];

for (const hook of HOOK_PATHS) {
  console.log(`\n=== Testing hook: ${hook.label} ===`);

  try {
    // Create sandbox
    const sandbox = await Sandbox.create({ timeoutMs: 120_000 });
    console.log(`  Sandbox created: ${sandbox.sandboxId}`);

    // Create parent dir if needed
    if (hook.mkdirParent) {
      await sandbox.runCommand("mkdir", ["-p", hook.mkdirParent]);
    }

    // Write hook script via runCommand (writeFiles has permission issues on system paths)
    const script = `#!/bin/bash\necho "hook-ran" > ${hook.resultFile}\ndate +%s%N >> ${hook.resultFile}`;
    await sandbox.runCommand("bash", ["-c", `cat > ${hook.path} << 'HOOKEOF'\n${script}\nHOOKEOF`]);
    await sandbox.runCommand("chmod", ["+x", hook.path]);

    // Verify hook was written
    const verify = await sandbox.runCommand("cat", [hook.path]);
    const verifyOut = await getOutput(verify);
    console.log(`  Hook written (${verifyOut.length} bytes)`);

    // Check if the file survives in the current sandbox
    const existsCheck = await sandbox.runCommand("ls", ["-la", hook.path]);
    console.log(`  File exists pre-snapshot: ${existsCheck.exitCode === 0 ? "YES" : "NO"}`);

    // Snapshot
    console.log("  Snapshotting...");
    const snap = await sandbox.snapshot();
    const snapshotId = snap.snapshotId || snap.snapshot?.id || snap.id;
    console.log(`  Snapshot: ${snapshotId}`);
    await sandbox.stop();

    // Restore
    console.log("  Restoring...");
    const restoreStart = performance.now();
    const restored = await Sandbox.create({
      snapshot: snapshotId,
      timeoutMs: 60_000,
    });
    const restoreMs = ms(restoreStart);
    console.log(`  Restored in ${restoreMs}ms`);

    // Check if hook file survived restore
    const fileCheck = await restored.runCommand("ls", ["-la", hook.path]);
    const fileSurvived = fileCheck.exitCode === 0;
    console.log(`  File survived restore: ${fileSurvived ? "YES" : "NO"}`);

    // Wait for any async hooks
    await new Promise((r) => setTimeout(r, 3000));

    // Check result
    const check = await restored.runCommand("cat", [hook.resultFile]);
    const checkOut = await getOutput(check);
    const ran = checkOut.includes("hook-ran");
    console.log(`  Hook auto-ran: ${ran ? "YES" : "NO"}`);
    if (ran) {
      console.log(`  Output: ${checkOut}`);
    }

    // Diagnostic: check what's in /vercel/sandbox/ and /tmp/
    if (!fileSurvived) {
      const diag = await restored.runCommand("bash", ["-c", "ls -la /vercel/sandbox/ 2>&1 | head -20"]);
      console.log(`  /vercel/sandbox/ contents: ${await getOutput(diag)}`);
    }

    results.push({ label: hook.label, fileSurvived, ran, restoreMs });
    await restored.stop();
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    results.push({ label: hook.label, fileSurvived: false, ran: false, restoreMs: 0, error: e.message });
  }
}

// ── Test Sandbox.create({ env }) ──
console.log("\n=== Testing Sandbox.create({ env }) on fresh create ===");
{
  try {
    const sandbox = await Sandbox.create({
      timeoutMs: 60_000,
      env: {
        MY_CUSTOM_VAR: "hello-from-env",
        GATEWAY_TOKEN: "test-token-123",
      },
    });
    console.log(`  Sandbox created with env: ${sandbox.sandboxId}`);

    const envCheck = await sandbox.runCommand("sh", ["-c", "echo $MY_CUSTOM_VAR"]);
    const envOut = await getOutput(envCheck);
    const envWorks = envOut === "hello-from-env";
    console.log(`  Env var accessible: ${envWorks ? "YES" : "NO"} (got: "${envOut}")`);

    // Also check GATEWAY_TOKEN
    const tokenCheck = await sandbox.runCommand("sh", ["-c", "echo $GATEWAY_TOKEN"]);
    const tokenOut = await getOutput(tokenCheck);
    console.log(`  GATEWAY_TOKEN accessible: ${tokenOut === "test-token-123" ? "YES" : "NO"} (got: "${tokenOut}")`);

    results.push({ label: "Sandbox.create({ env }) on fresh", fileSurvived: true, ran: envWorks, restoreMs: 0 });

    // Snapshot and restore with different env
    const snap = await sandbox.snapshot();
    const snapshotId = snap.snapshotId || snap.snapshot?.id || snap.id;
    await sandbox.stop();

    console.log("\n=== Testing Sandbox.create({ env }) on restore ===");
    const restored = await Sandbox.create({
      snapshot: snapshotId,
      timeoutMs: 60_000,
      env: {
        MY_CUSTOM_VAR: "hello-after-restore",
        NEW_VAR: "new-value",
      },
    });

    const envCheck2 = await restored.runCommand("sh", ["-c", "echo MY=$MY_CUSTOM_VAR NEW=$NEW_VAR GATE=$GATEWAY_TOKEN"]);
    const envOut2 = await getOutput(envCheck2);
    console.log(`  Env after restore: "${envOut2}"`);

    const restoreEnvWorks = envOut2.includes("MY=hello-after-restore") && envOut2.includes("NEW=new-value");
    const oldEnvCleared = !envOut2.includes("GATE=test-token-123");
    console.log(`  New env applied: ${restoreEnvWorks ? "YES" : "NO"}`);
    console.log(`  Old env cleared: ${oldEnvCleared ? "YES" : "NO"}`);

    results.push({ label: "Sandbox.create({ env }) on restore", fileSurvived: true, ran: restoreEnvWorks, restoreMs: 0 });

    await restored.stop();
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    results.push({ label: "Sandbox.create({ env })", fileSurvived: false, ran: false, restoreMs: 0, error: e.message });
  }
}

// ── Test .on-restore.sh + env combo (using /home/vercel-sandbox path) ──
console.log("\n=== Testing .on-restore.sh + env combo ===");
{
  try {
    const sandbox = await Sandbox.create({ timeoutMs: 60_000 });

    // Use /home/vercel-sandbox which might survive snapshot
    const hookScript = `#!/bin/bash
echo "GATEWAY=\$GATEWAY_TOKEN" > /tmp/env-hook-result.txt
if [ -n "\$GATEWAY_TOKEN" ]; then
  echo "token-present" >> /tmp/env-hook-result.txt
fi`;

    // Write to both locations
    await sandbox.runCommand("bash", ["-c", `cat > /vercel/sandbox/.on-restore.sh << 'EOF'\n${hookScript}\nEOF`]);
    await sandbox.runCommand("chmod", ["+x", "/vercel/sandbox/.on-restore.sh"]);
    await sandbox.runCommand("bash", ["-c", `cat > /home/vercel-sandbox/.on-restore.sh << 'EOF'\n${hookScript}\nEOF`]);
    await sandbox.runCommand("chmod", ["+x", "/home/vercel-sandbox/.on-restore.sh"]);

    const snap = await sandbox.snapshot();
    const snapshotId = snap.snapshotId || snap.snapshot?.id || snap.id;
    await sandbox.stop();

    const restored = await Sandbox.create({
      snapshot: snapshotId,
      timeoutMs: 60_000,
      env: {
        GATEWAY_TOKEN: "secret-abc-123",
      },
    });

    await new Promise((r) => setTimeout(r, 3000));

    // Check which files survived
    const check1 = await restored.runCommand("ls", ["-la", "/vercel/sandbox/.on-restore.sh"]);
    console.log(`  /vercel/sandbox/.on-restore.sh survived: ${check1.exitCode === 0 ? "YES" : "NO"}`);
    const check2 = await restored.runCommand("ls", ["-la", "/home/vercel-sandbox/.on-restore.sh"]);
    console.log(`  /home/vercel-sandbox/.on-restore.sh survived: ${check2.exitCode === 0 ? "YES" : "NO"}`);

    const result = await restored.runCommand("cat", ["/tmp/env-hook-result.txt"]);
    const resultOut = await getOutput(result);
    const hookRan = resultOut.includes("GATEWAY=");
    const envInHook = resultOut.includes("secret-abc-123");
    console.log(`  Hook ran: ${hookRan ? "YES" : "NO"}`);
    console.log(`  Env visible in hook: ${envInHook ? "YES" : "NO"}`);
    console.log(`  Output: ${resultOut}`);

    // Also check env directly
    const envDirect = await restored.runCommand("sh", ["-c", "echo $GATEWAY_TOKEN"]);
    console.log(`  Env directly accessible: "${await getOutput(envDirect)}"`);

    results.push({ label: ".on-restore.sh + env combo", fileSurvived: false, ran: hookRan && envInHook, restoreMs: 0 });

    await restored.stop();
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    results.push({ label: ".on-restore.sh + env combo", fileSurvived: false, ran: false, restoreMs: 0, error: e.message });
  }
}

// ── Summary ──
console.log("\n=== SUMMARY ===");
console.log("Hook Path".padEnd(45) + "Survived?  Auto-ran?");
console.log("-".repeat(65));
for (const r of results) {
  const survived = r.fileSurvived ? "YES" : "NO ";
  const ran = r.ran ? "YES" : "NO";
  const extra = r.error ? ` (ERROR)` : "";
  console.log(`${r.label.padEnd(45)}${survived.padEnd(11)}${ran}${extra}`);
}

console.log("\nDone.");
