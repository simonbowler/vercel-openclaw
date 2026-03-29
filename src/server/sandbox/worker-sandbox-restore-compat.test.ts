import assert from "node:assert/strict";
import test from "node:test";

import {
  OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
  OPENCLAW_WORKER_SANDBOX_SKILL_PATH,
  OPENCLAW_WORKER_SANDBOX_SCRIPT_PATH,
} from "@/server/openclaw/config";
import { ensureSandboxRunning } from "@/server/sandbox/lifecycle";
import { createScenarioHarness } from "@/test-utils/harness";

test("restore preloads worker-sandbox assets before boot for pre-feature snapshots", async () => {
  const h = createScenarioHarness();
  try {
    await h.mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-pre-worker-sandbox";
      meta.snapshotAssetSha256 = null;
      meta.lastRestoreMetrics = null;
      meta.sandboxId = null;
      meta.portUrls = null;
    });

    // Allow the gateway readiness probe to succeed
    h.fakeFetch.onGet(/fake\.vercel\.run/, () =>
      new Response('<div id="openclaw-app">ready</div>', { status: 200 }),
    );

    const callbacks: Array<() => Promise<void> | void> = [];
    await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "restore-preload-worker-sandbox",
      schedule(cb) {
        callbacks.push(cb);
      },
    });

    assert.equal(callbacks.length, 1);
    await callbacks[0]!();

    const handle = h.controller.lastCreated()!;
    const writtenPaths = handle.writtenFiles.map((file) => file.path);

    assert.ok(writtenPaths.includes(OPENCLAW_WORKER_SANDBOX_SKILL_PATH));
    assert.ok(writtenPaths.includes(OPENCLAW_WORKER_SANDBOX_SCRIPT_PATH));

    const writeIndex = h.controller.events.findIndex((event) => {
      if (event.kind !== "write_files") return false;
      const detail = event.detail as { paths?: unknown } | undefined;
      return (
        Array.isArray(detail?.paths) &&
        (detail.paths as string[]).includes(OPENCLAW_WORKER_SANDBOX_SKILL_PATH)
      );
    });

    const bootIndex = h.controller.events.findIndex((event) => {
      if (event.kind !== "command") return false;
      const detail = event.detail as { command?: unknown; args?: unknown } | undefined;
      return (
        detail?.command === "bash" &&
        Array.isArray(detail.args) &&
        detail.args[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH
      );
    });

    assert.ok(writeIndex >= 0, "worker-sandbox files should be written during restore");
    assert.ok(bootIndex >= 0, "fast restore script should run");
    assert.ok(
      writeIndex < bootIndex,
      "worker-sandbox files must exist before gateway boot",
    );
  } finally {
    h.teardown();
  }
});
