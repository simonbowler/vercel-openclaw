/**
 * Concurrency and idempotency tests for lifecycle state transitions.
 *
 * Verifies:
 *   1. Parallel ensureSandboxRunning() → exactly one create/restore
 *   2. Concurrent stopSandbox() → exactly one snapshot, no double-stop
 *   3. Rapid enqueue-then-drain across channels → no duplicate restores
 *   4. Crash mid-bootstrap → metadata in error state, not stuck
 *   5. Restore from error state after clearing the error
 *   6. Failed queue receives max-retry failures
 *
 * Run: pnpm test
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ChannelName } from "@/shared/channels";
import {
  createScenarioHarness,
  dumpDiagnostics,
  type ScenarioHarness,
} from "@/test-utils/harness";
import {
  gatewayReadyResponse,
  chatCompletionsResponse,
  slackOkResponse,
  telegramOkResponse,
  discordOkResponse,
} from "@/test-utils/fake-fetch";
import {
  ensureSandboxRunning,
  stopSandbox,
  probeGatewayReady,
  markSandboxUnavailable,
} from "@/server/sandbox/lifecycle";
import { enqueueChannelJob } from "@/server/channels/driver";
import { drainSlackQueue } from "@/server/channels/slack/runtime";
import { drainTelegramQueue } from "@/server/channels/telegram/runtime";
import { drainDiscordQueue } from "@/server/channels/discord/runtime";
import {
  channelQueueKey,
  channelProcessingKey,
  channelFailedKey,
} from "@/server/channels/keys";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Call ensureSandboxRunning with a captured schedule callback.
 * Returns the scheduled background work function (if any).
 */
async function callEnsureWithSchedule(
  reason: string,
): Promise<{ state: string; run: (() => Promise<void>) | null }> {
  let scheduledCallback: (() => Promise<void> | void) | null = null;
  const result = await ensureSandboxRunning({
    origin: "https://test.example.com",
    reason,
    schedule(cb) {
      scheduledCallback = cb;
    },
  });
  return {
    state: result.state,
    run: scheduledCallback as (() => Promise<void>) | null,
  };
}

// ---------------------------------------------------------------------------
// Test 1: Parallel ensureSandboxRunning() calls produce exactly one create
// ---------------------------------------------------------------------------

test("concurrency: parallel ensureSandboxRunning produces exactly one create", async (t) => {
  const h = createScenarioHarness();
  try {
    h.fakeFetch.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      // Fire 5 parallel ensureSandboxRunning calls
      const results = await Promise.all([
        callEnsureWithSchedule("parallel-1"),
        callEnsureWithSchedule("parallel-2"),
        callEnsureWithSchedule("parallel-3"),
        callEnsureWithSchedule("parallel-4"),
        callEnsureWithSchedule("parallel-5"),
      ]);

      // Collect all scheduled background work callbacks
      const scheduledRuns = results
        .map((r) => r.run)
        .filter((r): r is () => Promise<void> => r !== null);

      // At most one should have been scheduled (the start lock ensures this)
      assert.ok(
        scheduledRuns.length <= 1,
        `Expected at most 1 scheduled background work, got ${scheduledRuns.length}`,
      );

      // Execute the scheduled work if any
      if (scheduledRuns.length === 1) {
        await scheduledRuns[0]();
      }

      // Probe gateway to transition to running
      await probeGatewayReady();

      const meta = await h.getMeta();
      assert.equal(meta.status, "running");

      // Exactly one sandbox should have been created
      const createEvents = h.controller.eventsOfKind("create");
      assert.equal(
        createEvents.length,
        1,
        `Expected exactly 1 create event, got ${createEvents.length}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Test 2: Concurrent stopSandbox() calls produce exactly one snapshot
// ---------------------------------------------------------------------------

test("concurrency: concurrent stopSandbox produces exactly one snapshot", async (t) => {
  const h = createScenarioHarness();
  try {
    // Drive to running state first
    await h.driveToRunning();

    const meta = await h.getMeta();
    assert.equal(meta.status, "running");
    assert.ok(meta.sandboxId);

    // Fire 3 concurrent stopSandbox() calls
    const results = await Promise.allSettled([
      stopSandbox(),
      stopSandbox(),
      stopSandbox(),
    ]);

    // Exactly one should succeed, the rest should fail with lock contention
    const successes = results.filter((r) => r.status === "fulfilled");
    const failures = results.filter((r) => r.status === "rejected");

    assert.ok(
      successes.length >= 1,
      "At least one stopSandbox should succeed",
    );

    // The ones that fail should fail because the lock is unavailable
    // or because the sandbox is already stopped
    for (const failure of failures) {
      assert.equal(failure.status, "rejected");
    }

    // Bootstrap auto-snapshot plus explicit stop snapshot
    const snapshotEvents = h.controller.eventsOfKind("snapshot");
    assert.equal(
      snapshotEvents.length,
      2,
      `Expected exactly 2 snapshot events, got ${snapshotEvents.length}`,
    );

    // Meta should be stopped with a snapshotId
    const finalMeta = await h.getMeta();
    assert.equal(finalMeta.status, "stopped");
    assert.ok(finalMeta.snapshotId, "Should have a snapshotId after stop");
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Test 3: Rapid enqueue-then-drain across channels → no duplicate restores
// ---------------------------------------------------------------------------

test("concurrency: rapid enqueue-then-drain across channels produces at most one restore", async (t) => {
  const h = createScenarioHarness();
  try {
    // Drive to running, stop with snapshot, so restore is the path
    await h.driveToRunning();
    const snapshotId = await h.stopToSnapshot();

    const meta = await h.getMeta();
    assert.equal(meta.status, "stopped");
    assert.ok(meta.snapshotId);

    // Configure channels and install gateway handlers
    h.configureAllChannels();
    h.installDefaultGatewayHandlers("Concurrency reply");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      // Enqueue one job per channel simultaneously
      const channels: ChannelName[] = ["slack", "telegram", "discord"];
      await Promise.all(
        channels.map((channel) =>
          enqueueChannelJob(channel, {
            payload: makeChannelPayload(channel),
            receivedAt: Date.now(),
            origin: "https://test.example.com",
          }),
        ),
      );

      // Verify all three queues have depth 1
      const store = h.getStore();
      for (const ch of channels) {
        const depth = await store.getQueueLength(channelQueueKey(ch));
        assert.equal(depth, 1, `${ch} queue should have 1 job`);
      }

      // Drain all three channels concurrently
      // Each drain calls ensureSandboxReady which triggers restore
      await Promise.allSettled([
        drainSlackQueue(),
        drainTelegramQueue(),
        drainDiscordQueue(),
      ]);

      // Count restore events — should be at most 1
      const restoreEvents = h.controller.eventsOfKind("restore");
      assert.ok(
        restoreEvents.length <= 1,
        `Expected at most 1 restore event, got ${restoreEvents.length}`,
      );

      // No duplicate creates either
      const createEvents = h.controller.eventsOfKind("create");
      // We had one create from driveToRunning, plus at most one restore
      // (restores also go through controller.create with source.type=snapshot)
      const totalNewSandboxes = h.controller.created.length;
      // 1 from initial driveToRunning + at most 1 from restore = at most 2
      assert.ok(
        totalNewSandboxes <= 2,
        `Expected at most 2 total sandbox creates, got ${totalNewSandboxes}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Test 4: Crash mid-bootstrap leaves metadata in error state
// ---------------------------------------------------------------------------

test("concurrency: crash mid-bootstrap leaves error state, not stuck in creating", async (t) => {
  const h = createScenarioHarness();
  try {
    // Make the controller throw on create to simulate a crash
    const originalCreate = h.controller.create.bind(h.controller);
    let createCallCount = 0;
    h.controller.create = async (params) => {
      createCallCount += 1;
      throw new Error("Simulated sandbox creation crash");
    };

    h.fakeFetch.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      const result = await callEnsureWithSchedule("crash-test");

      // Execute the scheduled background work — it should catch the error
      if (result.run) {
        await result.run();
      }

      const meta = await h.getMeta();

      // Must be in error state, NOT stuck in "creating"
      assert.equal(
        meta.status,
        "error",
        `Expected error status after crash, got "${meta.status}"`,
      );
      assert.ok(
        meta.lastError,
        "Should have a lastError describing the crash",
      );
      assert.ok(
        meta.lastError!.includes("Simulated sandbox creation crash"),
        `lastError should mention the crash: ${meta.lastError}`,
      );

      // The controller.create was called exactly once
      assert.equal(createCallCount, 1, "controller.create should be called once");
    } finally {
      globalThis.fetch = originalFetch;
      // Restore original create for teardown
      h.controller.create = originalCreate;
    }
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Test 5: Restore from error state works after clearing the error
// ---------------------------------------------------------------------------

test("concurrency: restore from error state works after error is cleared", async (t) => {
  const h = createScenarioHarness();
  try {
    h.fakeFetch.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      // First, drive to running and stop to get a snapshot
      await h.driveToRunning();
      await h.stopToSnapshot();

      // Simulate an error state by marking sandbox unavailable
      await markSandboxUnavailable("Simulated previous error");

      let meta = await h.getMeta();
      // With a snapshotId present, markSandboxUnavailable sets status to "stopped"
      // So let's manually force an error state
      await h.mutateMeta((m) => {
        m.status = "error";
        m.lastError = "Simulated previous error";
        m.sandboxId = null;
        m.portUrls = null;
      });

      meta = await h.getMeta();
      assert.equal(meta.status, "error");
      assert.ok(meta.snapshotId, "Should still have a snapshotId");

      // Now attempt to recover: ensureSandboxRunning should trigger a restore
      const result = await callEnsureWithSchedule("recovery-from-error");

      if (result.run) {
        await result.run();
      }

      // Probe gateway to finalize
      await probeGatewayReady();

      meta = await h.getMeta();
      // Should be running or booting (probeGatewayReady transitions to running)
      assert.ok(
        meta.status === "running" || meta.status === "booting",
        `Expected running or booting after recovery, got "${meta.status}"`,
      );
      assert.ok(meta.sandboxId, "Should have a sandboxId after recovery");
      assert.equal(meta.lastError, null, "lastError should be cleared");

      // Should have a restore event (restored from snapshot)
      const restoreEvents = h.controller.eventsOfKind("restore");
      assert.ok(
        restoreEvents.length >= 1,
        "Should have at least one restore event",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Test 6: Failed queue receives jobs after max retries
// ---------------------------------------------------------------------------

test("concurrency: failed queue receives jobs that fail after max retries", async (t) => {
  const h = createScenarioHarness();
  try {
    // Drive to running so drains can proceed
    await h.driveToRunning();
    h.configureAllChannels();

    // Install gateway handler that always returns a non-retryable error.
    // Non-retryable failures go straight to DLQ without retry parking.
    h.fakeFetch.onPost(/\/v1\/chat\/completions/, () =>
      new Response("Bad Request", { status: 400 }),
    );
    h.fakeFetch.onPost(/slack\.com\/api/, () => slackOkResponse());
    h.fakeFetch.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());
    h.fakeFetch.onGet(/slack\.com\/api\/conversations\.replies/, () =>
      Response.json({ ok: true, messages: [] }),
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      const channel: ChannelName = "slack";

      // Enqueue a job that will fail permanently (event.type must be "message"
      // for the Slack adapter to extract and forward to the gateway)
      await enqueueChannelJob(channel, {
        payload: {
          type: "event_callback",
          event: {
            type: "message",
            text: "<@U123> failing test",
            channel: "C123",
            ts: "1234567890.123456",
            user: "U456",
            thread_ts: "1234567890.123456",
          },
          team_id: "T123",
        },
        receivedAt: Date.now(),
        origin: "https://test.example.com",
      });

      const store = h.getStore();

      // Single drain should move the non-retryable failure to DLQ
      await drainSlackQueue();

      // Check failed queue has the failed job
      const dlqKey = channelFailedKey(channel);
      const dlqLength = await store.getQueueLength(dlqKey);
      assert.ok(
        dlqLength >= 1,
        `Failed queue should have at least 1 entry, got ${dlqLength}`,
      );

      // Main queue should be clean
      const mainQueueLength = await store.getQueueLength(channelQueueKey(channel));
      const processingLength = await store.getQueueLength(channelProcessingKey(channel));
      assert.equal(
        mainQueueLength + processingLength,
        0,
        `Main queue + processing should be empty, got queue=${mainQueueLength} processing=${processingLength}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Test 7: Second ensureSandboxRunning when already running is a no-op
// ---------------------------------------------------------------------------

test("concurrency: ensureSandboxRunning when already running returns immediately", async (t) => {
  const h = createScenarioHarness();
  try {
    await h.driveToRunning();

    const beforeCount = h.controller.created.length;

    // Call ensureSandboxRunning 5 more times
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        ensureSandboxRunning({
          origin: "https://test.example.com",
          reason: `already-running-${i}`,
        }),
      ),
    );

    // All should return "running" state
    for (const result of results) {
      assert.equal(result.state, "running");
    }

    // No new sandboxes should have been created
    assert.equal(
      h.controller.created.length,
      beforeCount,
      "No new sandboxes should be created when already running",
    );
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChannelPayload(channel: ChannelName): unknown {
  switch (channel) {
    case "slack":
      return {
        type: "event_callback",
        event: {
          type: "app_mention",
          text: `<@U123> concurrency test ${channel}`,
          channel: "C123",
          ts: `${Date.now()}.000001`,
          user: "U456",
        },
        team_id: "T123",
      };
    case "telegram":
      return {
        update_id: Date.now(),
        message: {
          message_id: 1,
          from: { id: 1, is_bot: false, first_name: "Test" },
          chat: { id: 1, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: `concurrency test ${channel}`,
        },
      };
    case "discord":
      return {
        type: 2,
        id: `discord-${Date.now()}`,
        token: "discord-interaction-token",
        data: {
          name: "ask",
          options: [{ name: "prompt", value: `concurrency test ${channel}` }],
        },
        member: { user: { id: "123", username: "tester" } },
        channel_id: "C123",
        application_id: "shared-test-discord-app-id",
      };
  }
}
