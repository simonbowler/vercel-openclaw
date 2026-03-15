/**
 * Scenario-driven integration tests for lifecycle + channel webhook flows.
 *
 * These tests exercise the lifecycle state machine and channel webhook
 * enqueue → drain → reply paths using the shared test harness, without
 * any real network calls or sandbox API calls.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createScenarioHarness,
  type ScenarioHarness,
  type SandboxEvent,
} from "@/test-utils/harness";
import {
  chatCompletionsResponse,
  gatewayReadyResponse,
  slackOkResponse,
  telegramOkResponse,
  discordOkResponse,
} from "@/test-utils/fake-fetch";
import {
  buildSlackWebhook,
  buildTelegramWebhook,
  buildDiscordWebhook,
  generateDiscordKeyPair,
} from "@/test-utils/webhook-builders";
import {
  ensureSandboxRunning,
  stopSandbox,
  probeGatewayReady,
} from "@/server/sandbox/lifecycle";
import { enqueueChannelJob } from "@/server/channels/driver";
import { drainSlackQueue } from "@/server/channels/slack/runtime";
import { drainTelegramQueue } from "@/server/channels/telegram/runtime";
import { drainDiscordQueue } from "@/server/channels/discord/runtime";
import { channelQueueKey, channelProcessingKey } from "@/server/channels/keys";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Drive a sandbox from uninitialized → running by scheduling the create
 * callback and executing it, then probing gateway readiness.
 */
async function driveToRunning(h: ScenarioHarness): Promise<void> {
  // Set up gateway probe to return ready
  h.fakeFetch.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());

  // Install global fetch override for gateway probes
  const originalFetch = globalThis.fetch;
  globalThis.fetch = h.fakeFetch.fetch;

  try {
    let scheduledCallback: (() => Promise<void> | void) | null = null;

    const result = await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "scenario-test",
      schedule(cb) {
        scheduledCallback = cb;
      },
    });

    assert.equal(result.state, "waiting");
    assert.ok(scheduledCallback, "Background work should have been scheduled");

    // Execute the scheduled background work (create + bootstrap)
    await (scheduledCallback as () => Promise<void> | void)();

    // Probe should detect readiness and set status to running
    const probe = await probeGatewayReady();
    if (!probe.ready) {
      // If the lifecycle itself already set running, that's also fine
      const meta = await h.getMeta();
      assert.equal(meta.status, "running", "Sandbox should be running after bootstrap");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/**
 * Configure channel configs in meta for all three platforms.
 */
async function configureAllChannels(
  h: ScenarioHarness,
  discordPublicKeyHex: string,
): Promise<{ slackSigningSecret: string; telegramWebhookSecret: string }> {
  const slackSigningSecret = "test-slack-signing-secret-0123456789abcdef";
  const telegramWebhookSecret = "test-telegram-webhook-secret";

  await h.mutateMeta((meta) => {
    meta.channels.slack = {
      signingSecret: slackSigningSecret,
      botToken: "xoxb-test-slack-bot-token",
      configuredAt: Date.now(),
    };
    meta.channels.telegram = {
      botToken: "test-telegram-bot-token",
      webhookSecret: telegramWebhookSecret,
      webhookUrl: "https://test.example.com/api/channels/telegram/webhook",
      botUsername: "test_bot",
      configuredAt: Date.now(),
    };
    meta.channels.discord = {
      publicKey: discordPublicKeyHex,
      applicationId: "test-discord-app-id",
      botToken: "test-discord-bot-token",
      configuredAt: Date.now(),
    };
  });

  return { slackSigningSecret, telegramWebhookSecret };
}

/**
 * Set up fake fetch handlers for chat completions + platform reply APIs.
 */
function setupChannelFetchHandlers(h: ScenarioHarness): void {
  // Gateway chat completions
  h.fakeFetch.onPost(/\/v1\/chat\/completions/, () =>
    chatCompletionsResponse("Hello from OpenClaw"),
  );
  // Slack API replies
  h.fakeFetch.onPost(/slack\.com\/api/, () => slackOkResponse());
  // Telegram API replies
  h.fakeFetch.onPost(/api\.telegram\.org/, () => telegramOkResponse());
  // Discord webhook/channel replies
  h.fakeFetch.onPatch(/discord\.com/, () => discordOkResponse());
  h.fakeFetch.onPost(/discord\.com/, () => discordOkResponse());
  // Gateway probes
  h.fakeFetch.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());
  // Slack conversations.replies (thread history) — return empty
  h.fakeFetch.onGet(/slack\.com\/api\/conversations\.replies/, () =>
    Response.json({ ok: true, messages: [] }),
  );
}

// ===========================================================================
// Lifecycle Scenarios
// ===========================================================================

test("Scenario: uninitialized → ensureSandboxRunning → creating → running (happy path)", async () => {
  const h = createScenarioHarness();
  try {
    // Verify initial state
    const initialMeta = await h.getMeta();
    assert.equal(initialMeta.status, "uninitialized");

    // Drive to running
    await driveToRunning(h);

    const meta = await h.getMeta();
    assert.equal(meta.status, "running");
    assert.ok(meta.sandboxId, "sandboxId should be set");
    assert.ok(meta.portUrls, "portUrls should be set");
    assert.equal(h.controller.created.length, 1, "Should have created exactly one sandbox");
  } finally {
    h.teardown();
  }
});

test("Scenario: running → stopSandbox → snapshot created → status stopped → snapshotId set → snapshotHistory updated", async () => {
  const h = createScenarioHarness();
  try {
    await driveToRunning(h);

    const runningMeta = await h.getMeta();
    assert.equal(runningMeta.status, "running");
    const sandboxId = runningMeta.sandboxId!;

    const result = await stopSandbox();

    assert.equal(result.status, "stopped");
    assert.ok(result.snapshotId, "snapshotId should be set after stop");
    assert.ok(result.snapshotId.startsWith("snap-"), "snapshotId should have snap- prefix");
    assert.equal(result.sandboxId, null, "sandboxId should be cleared");
    assert.equal(result.portUrls, null, "portUrls should be cleared");

    // Verify snapshot history
    assert.ok(result.snapshotHistory.length > 0, "snapshotHistory should have an entry");
    assert.equal(result.snapshotHistory[0]!.snapshotId, result.snapshotId);
    assert.equal(result.snapshotHistory[0]!.reason, "stop");

    // Verify the fake controller's handle was called
    const handle = h.controller.getHandle(sandboxId);
    assert.ok(handle, "Should have retrieved the sandbox handle");
    assert.ok(handle.snapshotCalled, "snapshot() should have been called on the handle");
  } finally {
    h.teardown();
  }
});

test("Scenario: stopped → ensureSandboxRunning → restoring → running with correct snapshotId", async () => {
  const h = createScenarioHarness();
  try {
    // Create and stop to get a snapshot
    await driveToRunning(h);
    const stopResult = await stopSandbox();
    const snapshotId = stopResult.snapshotId!;
    assert.ok(snapshotId);

    // Now restore from the snapshot
    h.fakeFetch.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      let scheduledCallback: (() => Promise<void> | void) | null = null;

      const result = await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "restore-test",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });

      assert.equal(result.state, "waiting");

      // Meta should now be "restoring"
      let meta = await h.getMeta();
      assert.equal(meta.status, "restoring");

      assert.ok(scheduledCallback, "Background work should have been scheduled");
      await (scheduledCallback as () => Promise<void> | void)();

      meta = await h.getMeta();
      // After restore, it should be running or booting
      assert.ok(
        meta.status === "running" || meta.status === "booting",
        `Expected running or booting, got: ${meta.status}`,
      );

      // If booting, probe to transition to running
      if (meta.status === "booting") {
        await probeGatewayReady();
        meta = await h.getMeta();
      }
      assert.equal(meta.status, "running");

      // The original snapshotId should still be in meta
      assert.equal(meta.snapshotId, snapshotId, "snapshotId should be preserved from restore");

      // Should have created a second sandbox (for the restore)
      assert.equal(h.controller.created.length, 2, "Should have created two sandboxes total");

      // The second create should have used the snapshot source
      // (We can't directly inspect the create params from FakeSandboxController,
      // but we can verify the restore happened by checking state transitions)
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

// ===========================================================================
// Channel Webhook Scenarios
// ===========================================================================

test("Scenario: Slack webhook while stopped triggers enqueue + restore + drain + single reply", async () => {
  const h = createScenarioHarness();
  try {
    const discordKeys = generateDiscordKeyPair();
    const { slackSigningSecret } = await configureAllChannels(
      h,
      discordKeys.publicKeyHex,
    );

    // Drive to running, then stop
    await driveToRunning(h);
    await stopSandbox();

    let meta = await h.getMeta();
    assert.equal(meta.status, "stopped");

    // Set up fake fetch handlers for drain flow
    setupChannelFetchHandlers(h);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      // Build a signed Slack webhook request and extract the payload
      const slackReq = buildSlackWebhook({ signingSecret: slackSigningSecret });
      const slackBody = await slackReq.text();
      const slackPayload = JSON.parse(slackBody);

      // Enqueue the job (same as what the route handler does)
      await enqueueChannelJob("slack", {
        payload: slackPayload,
        receivedAt: Date.now(),
        origin: "https://test.example.com",
      });

      // Verify job is queued
      const store = h.getStore();
      const queueDepth = await store.getQueueLength(channelQueueKey("slack"));
      assert.equal(queueDepth, 1, "Should have one job in the queue");

      // Drain triggers ensureSandboxReady which drives the restore
      await drainSlackQueue();

      // Verify sandbox was restored and is running
      meta = await h.getMeta();
      assert.equal(meta.status, "running");

      // Verify reply was sent (check for Slack API call)
      const slackRequests = h.fakeFetch
        .requests()
        .filter((r) => r.url.includes("slack.com/api"));
      assert.ok(
        slackRequests.length >= 1,
        `Expected at least one Slack API call, got ${slackRequests.length}`,
      );

      // Verify queue is drained
      const remainingQueue = await store.getQueueLength(channelQueueKey("slack"));
      const remainingProcessing = await store.getQueueLength(channelProcessingKey("slack"));
      assert.equal(remainingQueue, 0, "Queue should be empty after drain");
      assert.equal(remainingProcessing, 0, "Processing queue should be empty after drain");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

test("Scenario: Telegram webhook while stopped triggers enqueue + restore + drain + single reply", async () => {
  const h = createScenarioHarness();
  try {
    const discordKeys = generateDiscordKeyPair();
    const { telegramWebhookSecret } = await configureAllChannels(
      h,
      discordKeys.publicKeyHex,
    );

    // Drive to running, then stop
    await driveToRunning(h);
    await stopSandbox();

    let meta = await h.getMeta();
    assert.equal(meta.status, "stopped");

    setupChannelFetchHandlers(h);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      // Build a Telegram webhook request and extract payload
      const telegramReq = buildTelegramWebhook({
        webhookSecret: telegramWebhookSecret,
      });
      const telegramBody = await telegramReq.text();
      const telegramPayload = JSON.parse(telegramBody);

      // Enqueue
      await enqueueChannelJob("telegram", {
        payload: telegramPayload,
        receivedAt: Date.now(),
        origin: "https://test.example.com",
      });

      const store = h.getStore();
      const queueDepth = await store.getQueueLength(channelQueueKey("telegram"));
      assert.equal(queueDepth, 1, "Should have one job in the queue");

      // Drain triggers restore
      await drainTelegramQueue();

      meta = await h.getMeta();
      assert.equal(meta.status, "running");

      // Verify Telegram API call was made (sendMessage or sendChatAction)
      const telegramRequests = h.fakeFetch
        .requests()
        .filter((r) => r.url.includes("api.telegram.org"));
      assert.ok(
        telegramRequests.length >= 1,
        `Expected at least one Telegram API call, got ${telegramRequests.length}`,
      );

      // Queue drained
      const remaining = await store.getQueueLength(channelQueueKey("telegram"));
      assert.equal(remaining, 0, "Queue should be empty after drain");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

test("Scenario: Discord interaction while stopped triggers enqueue + restore + drain + single reply", async () => {
  const h = createScenarioHarness();
  try {
    const discordKeys = generateDiscordKeyPair();
    await configureAllChannels(h, discordKeys.publicKeyHex);

    // Drive to running, then stop
    await driveToRunning(h);
    await stopSandbox();

    let meta = await h.getMeta();
    assert.equal(meta.status, "stopped");

    setupChannelFetchHandlers(h);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      // Build a Discord webhook request and extract payload
      const discordReq = buildDiscordWebhook({
        privateKey: discordKeys.privateKey,
        publicKeyHex: discordKeys.publicKeyHex,
      });
      const discordBody = await discordReq.text();
      const discordPayload = JSON.parse(discordBody);

      // Enqueue
      await enqueueChannelJob("discord", {
        payload: discordPayload,
        receivedAt: Date.now(),
        origin: "https://test.example.com",
      });

      const store = h.getStore();
      const queueDepth = await store.getQueueLength(channelQueueKey("discord"));
      assert.equal(queueDepth, 1, "Should have one job in the queue");

      // Drain triggers restore
      await drainDiscordQueue();

      meta = await h.getMeta();
      assert.equal(meta.status, "running");

      // Verify Discord API call was made (PATCH for webhook edit or POST for channel message)
      const discordRequests = h.fakeFetch
        .requests()
        .filter((r) => r.url.includes("discord.com"));
      assert.ok(
        discordRequests.length >= 1,
        `Expected at least one Discord API call, got ${discordRequests.length}`,
      );

      // Queue drained
      const remaining = await store.getQueueLength(channelQueueKey("discord"));
      assert.equal(remaining, 0, "Queue should be empty after drain");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

test("Scenario: Webhook during restoring state does not trigger second restore, only enqueues", async () => {
  const h = createScenarioHarness();
  try {
    const discordKeys = generateDiscordKeyPair();
    const { slackSigningSecret } = await configureAllChannels(
      h,
      discordKeys.publicKeyHex,
    );

    // Drive to running, stop, then set status to restoring manually
    // (simulating a restore already in progress)
    await driveToRunning(h);
    await stopSandbox();

    const stoppedMeta = await h.getMeta();
    assert.ok(stoppedMeta.snapshotId);

    // Simulate that a restore is already in progress
    await h.mutateMeta((meta) => {
      meta.status = "restoring";
    });

    let meta = await h.getMeta();
    assert.equal(meta.status, "restoring");

    const createdBefore = h.controller.created.length;

    // Try ensureSandboxRunning — should return waiting without scheduling new work
    const result = await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "webhook-during-restore",
      schedule() {
        // This should not be called since we're already restoring
        assert.fail("Should not schedule new work while restoring");
      },
    });

    assert.equal(result.state, "waiting");
    assert.equal(
      h.controller.created.length,
      createdBefore,
      "Should not have created a new sandbox during restore",
    );

    // Enqueue a Slack job — this should succeed without triggering restore
    const slackReq = buildSlackWebhook({ signingSecret: slackSigningSecret });
    const slackBody = await slackReq.text();
    const slackPayload = JSON.parse(slackBody);

    await enqueueChannelJob("slack", {
      payload: slackPayload,
      receivedAt: Date.now(),
      origin: "https://test.example.com",
    });

    const store = h.getStore();
    const queueDepth = await store.getQueueLength(channelQueueKey("slack"));
    assert.equal(queueDepth, 1, "Job should be enqueued even during restoring state");

    // Status should still be restoring (no second restore triggered)
    meta = await h.getMeta();
    assert.equal(meta.status, "restoring");
  } finally {
    h.teardown();
  }
});

// ===========================================================================
// Event-log-based restore fidelity tests
// ===========================================================================

test("Scenario: running → stop (snapshot event) → restore (restore event) → running with correct event sequence", async () => {
  const h = createScenarioHarness();
  try {
    // Phase 1: create and verify create event
    await driveToRunning(h);

    const createEvents = h.controller.eventsOfKind("create");
    assert.equal(createEvents.length, 1, "Should have one create event");
    assert.ok(createEvents[0]!.timestamp > 0, "Create event should have a timestamp");
    assert.equal(createEvents[0]!.sandboxId, "sbx-fake-1");

    // Phase 2: stop and verify snapshot event
    const beforeStop = Date.now();
    await stopSandbox();
    const afterStop = Date.now();

    const snapshotEvents = h.controller.eventsOfKind("snapshot");
    // 2 snapshots: one auto-snapshot after bootstrap, one from stopSandbox
    assert.equal(snapshotEvents.length, 2, "Should have two snapshot events (bootstrap + stop)");
    const stopSnapshot = snapshotEvents[snapshotEvents.length - 1]!;
    assert.ok(
      stopSnapshot.timestamp >= beforeStop && stopSnapshot.timestamp <= afterStop,
      "Stop snapshot event timestamp should be within the stop window",
    );
    assert.equal(stopSnapshot.sandboxId, "sbx-fake-1");

    const meta = await h.getMeta();
    assert.equal(meta.status, "stopped");
    assert.ok(meta.snapshotId, "snapshotId should be set after stop");

    // Phase 3: restore and verify restore event
    h.fakeFetch.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      const beforeRestore = Date.now();

      let scheduledCallback: (() => Promise<void> | void) | null = null;
      await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "restore-event-test",
        schedule(cb) {
          scheduledCallback = cb;
        },
      });

      assert.ok(scheduledCallback);
      await (scheduledCallback as () => Promise<void>)();

      const afterRestore = Date.now();

      // Verify restore event was recorded
      const restoreEvents = h.controller.eventsOfKind("restore");
      assert.equal(restoreEvents.length, 1, "Should have one restore event");
      assert.ok(
        restoreEvents[0]!.timestamp >= beforeRestore && restoreEvents[0]!.timestamp <= afterRestore,
        "Restore event timestamp should be within the restore window",
      );
      assert.equal(restoreEvents[0]!.sandboxId, "sbx-fake-2");
      assert.deepEqual(
        restoreEvents[0]!.detail,
        { snapshotId: meta.snapshotId },
        "Restore event should reference the correct snapshotId",
      );

      // Verify final running state
      const restored = await h.getMeta();
      assert.equal(restored.status, "running");

      // Verify overall event sequence: create → bootstrap snapshot → stop snapshot → restore
      const lifecycleEvents = h.controller.events.filter((e) =>
        ["create", "snapshot", "restore"].includes(e.kind),
      );
      assert.equal(lifecycleEvents.length, 4);
      assert.equal(lifecycleEvents[0]!.kind, "create");
      assert.equal(lifecycleEvents[1]!.kind, "snapshot"); // bootstrap auto-snapshot
      assert.equal(lifecycleEvents[2]!.kind, "snapshot"); // stop snapshot
      assert.equal(lifecycleEvents[3]!.kind, "restore");

      // Timestamps must be monotonically non-decreasing
      for (let i = 1; i < lifecycleEvents.length; i++) {
        assert.ok(
          lifecycleEvents[i]!.timestamp >= lifecycleEvents[i - 1]!.timestamp,
          `Event ${lifecycleEvents[i]!.kind} timestamp should be >= ${lifecycleEvents[i - 1]!.kind} timestamp`,
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

test("Scenario: channel message while stopped → triggers restore → message processed after ready (event log)", async () => {
  const h = createScenarioHarness();
  try {
    const discordKeys = generateDiscordKeyPair();
    const { slackSigningSecret } = await configureAllChannels(
      h,
      discordKeys.publicKeyHex,
    );

    // Create → running → stop
    await driveToRunning(h);
    await stopSandbox();

    const stoppedMeta = await h.getMeta();
    assert.equal(stoppedMeta.status, "stopped");
    assert.ok(stoppedMeta.snapshotId);

    // Verify we have create + snapshot events so far
    // 2 snapshots: one auto-snapshot after bootstrap, one from stopSandbox
    assert.equal(h.controller.eventsOfKind("create").length, 1);
    assert.equal(h.controller.eventsOfKind("snapshot").length, 2);
    assert.equal(h.controller.eventsOfKind("restore").length, 0, "No restore yet");

    // Set up handlers for drain
    setupChannelFetchHandlers(h);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      // Enqueue a Slack message while stopped
      const slackReq = buildSlackWebhook({ signingSecret: slackSigningSecret });
      const slackBody = await slackReq.text();
      const slackPayload = JSON.parse(slackBody);

      await enqueueChannelJob("slack", {
        payload: slackPayload,
        receivedAt: Date.now(),
        origin: "https://test.example.com",
      });

      const store = h.getStore();
      assert.equal(
        await store.getQueueLength(channelQueueKey("slack")),
        1,
        "Message should be queued",
      );

      // Drain triggers restore internally
      await drainSlackQueue();

      // Verify restore event was recorded
      const restoreEvents = h.controller.eventsOfKind("restore");
      assert.equal(restoreEvents.length, 1, "Drain should have triggered exactly one restore");
      assert.deepEqual(
        restoreEvents[0]!.detail,
        { snapshotId: stoppedMeta.snapshotId },
        "Restore should use the correct snapshot",
      );

      // Verify sandbox is running and message was processed
      const finalMeta = await h.getMeta();
      assert.equal(finalMeta.status, "running");

      const slackRequests = h.fakeFetch
        .requests()
        .filter((r) => r.url.includes("slack.com/api"));
      assert.ok(slackRequests.length >= 1, "Slack reply should have been sent");

      assert.equal(
        await store.getQueueLength(channelQueueKey("slack")),
        0,
        "Queue should be drained",
      );

      // Full event sequence: create → bootstrap snapshot → stop snapshot → restore
      const lifecycle = h.controller.events
        .filter((e) => ["create", "snapshot", "restore"].includes(e.kind))
        .map((e) => e.kind);
      assert.deepEqual(lifecycle, ["create", "snapshot", "snapshot", "restore"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});

test("Scenario: multiple rapid restore requests deduplicate to one restore operation", async () => {
  const h = createScenarioHarness();
  try {
    // Create → running → stop
    await driveToRunning(h);
    await stopSandbox();

    const stoppedMeta = await h.getMeta();
    assert.equal(stoppedMeta.status, "stopped");
    assert.ok(stoppedMeta.snapshotId);

    h.fakeFetch.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      // Fire multiple concurrent ensureSandboxRunning calls
      const callbacks: Array<() => Promise<void> | void> = [];

      const results = await Promise.all([
        ensureSandboxRunning({
          origin: "https://test.example.com",
          reason: "rapid-1",
          schedule(cb) { callbacks.push(cb); },
        }),
        ensureSandboxRunning({
          origin: "https://test.example.com",
          reason: "rapid-2",
          schedule(cb) { callbacks.push(cb); },
        }),
        ensureSandboxRunning({
          origin: "https://test.example.com",
          reason: "rapid-3",
          schedule(cb) { callbacks.push(cb); },
        }),
      ]);

      // All should return waiting
      for (const r of results) {
        assert.equal(r.state, "waiting");
      }

      // Only one callback should have been scheduled (start lock deduplicates)
      assert.ok(
        callbacks.length <= 1,
        `Expected at most 1 scheduled callback, got ${callbacks.length} (lock dedup should prevent extra work)`,
      );

      // Execute whatever was scheduled
      for (const cb of callbacks) {
        await cb();
      }

      // Probe to ensure running state
      const meta = await h.getMeta();
      if (meta.status !== "running") {
        await probeGatewayReady();
      }

      const finalMeta = await h.getMeta();
      assert.equal(finalMeta.status, "running");

      // Only one restore event should exist
      const restoreEvents = h.controller.eventsOfKind("restore");
      assert.equal(
        restoreEvents.length,
        1,
        `Expected exactly 1 restore event, got ${restoreEvents.length} — rapid requests should deduplicate`,
      );

      // Total creates: 1 (initial) + 1 (restore) = 2
      assert.equal(h.controller.created.length, 2, "Should have created exactly 2 sandboxes total");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    h.teardown();
  }
});
