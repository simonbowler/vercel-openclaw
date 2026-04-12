import type {
  StatusPayload,
  RunAction,
  RequestJson,
  ActionSuccessMeta,
  FirewallReportPayload,
} from "@/components/admin-types";
import type { ReadJsonDeps } from "@/components/admin-request-core";
import {
  DEFAULT_STATUS_LIFECYCLE,
  DEFAULT_STATUS_RESTORE_TARGET,
} from "@/components/status-payload-defaults";
import type { ChannelConnectability } from "@/shared/channel-connectability";
import type { LogEntry } from "@/shared/types";
import type { SnapshotRecord } from "@/shared/types";

/* ── Helpers ── */

function makeConnectability(
  channel: ChannelConnectability["channel"],
  webhookUrl: string | null,
): ChannelConnectability {
  return {
    channel,
    mode: "webhook-proxied",
    canConnect: true,
    status: "pass",
    webhookUrl,
    issues: [],
  };
}

const CHANNELS_UNCONFIGURED: StatusPayload["channels"] = {
  slack: {
    configured: false,
    webhookUrl: "",
    configuredAt: null,
    team: null,
    user: null,
    botId: null,
    hasSigningSecret: false,
    hasBotToken: false,
    lastError: null,
    connectability: makeConnectability("slack", ""),
    installMethod: "manual",
    installUrl: null,
    appCredentialsConfigured: false,
  },
  telegram: {
    configured: false,
    webhookUrl: null,
    botUsername: null,
    configuredAt: null,
    lastError: null,
    status: "disconnected",
    commandSyncStatus: "unsynced",
    commandsRegisteredAt: null,
    commandSyncError: null,
    connectability: makeConnectability("telegram", null),
  },
  discord: {
    configured: false,
    webhookUrl: "",
    applicationId: null,
    publicKey: null,
    configuredAt: null,
    appName: null,
    botUsername: null,
    endpointConfigured: false,
    endpointUrl: null,
    endpointError: null,
    commandRegistered: false,
    commandId: null,
    inviteUrl: null,
    isPublicUrl: false,
    connectability: makeConnectability("discord", ""),
  },
  whatsapp: {
    configured: false,
    mode: "webhook-proxied",
    webhookUrl: null,
    status: "unconfigured",
    configuredAt: null,
    displayName: null,
    linkedPhone: null,
    lastError: null,
    requiresRunningSandbox: false,
    loginVia: "/gateway",
    connectability: makeConnectability("whatsapp", null),
  },
};

const CHANNELS_CONFIGURED: StatusPayload["channels"] = {
  slack: {
    configured: true,
    webhookUrl: "https://app.example.com/api/channels/slack/events",
    configuredAt: Date.now() - 86_400_000,
    team: "Acme Corp",
    user: "openclaw-bot",
    botId: "B0123ABC",
    hasSigningSecret: true,
    hasBotToken: true,
    lastError: null,
    connectability: makeConnectability(
      "slack",
      "https://app.example.com/api/channels/slack/events",
    ),
    installMethod: "oauth",
    installUrl: null,
    appCredentialsConfigured: true,
  },
  telegram: {
    configured: true,
    webhookUrl: "https://app.example.com/api/channels/telegram/webhook",
    botUsername: "openclaw_bot",
    configuredAt: Date.now() - 86_400_000,
    lastError: null,
    status: "connected",
    commandSyncStatus: "synced",
    commandsRegisteredAt: Date.now() - 3_600_000,
    commandSyncError: null,
    connectability: makeConnectability(
      "telegram",
      "https://app.example.com/api/channels/telegram/webhook",
    ),
  },
  discord: {
    configured: true,
    webhookUrl: "https://app.example.com/api/channels/discord/interactions",
    applicationId: "1234567890",
    publicKey: "abc123pubkey",
    configuredAt: Date.now() - 86_400_000,
    appName: "OpenClaw Bot",
    botUsername: "OpenClaw#1234",
    endpointConfigured: true,
    endpointUrl:
      "https://app.example.com/api/channels/discord/interactions",
    endpointError: null,
    commandRegistered: true,
    commandId: "cmd-123",
    inviteUrl: "https://discord.com/oauth2/authorize?client_id=1234567890",
    isPublicUrl: true,
    connectability: makeConnectability(
      "discord",
      "https://app.example.com/api/channels/discord/interactions",
    ),
  },
  whatsapp: {
    configured: true,
    mode: "webhook-proxied",
    webhookUrl: "https://app.example.com/api/channels/whatsapp/webhook",
    status: "linked",
    configuredAt: Date.now() - 86_400_000,
    displayName: "OpenClaw Support",
    linkedPhone: "+1 555-0100",
    lastError: null,
    requiresRunningSandbox: false,
    loginVia: "/gateway",
    connectability: makeConnectability(
      "whatsapp",
      "https://app.example.com/api/channels/whatsapp/webhook",
    ),
  },
};

function makeStatus(overrides: Partial<StatusPayload> = {}): StatusPayload {
  return {
    authMode: "admin-secret",
    storeBackend: "upstash",
    persistentStore: true,
    sandboxSdkVersion: "2.0.0-beta.10",
    openclawVersion: "2026.4.11",
    status: "running",
    sandboxId: "sbx-abc123",
    snapshotId: "snap-xyz789",
    gatewayReady: true,
    gatewayStatus: "ready",
    gatewayCheckedAt: Date.now() - 5_000,
    gatewayUrl: "/gateway",
    lastError: null,
    lastKeepaliveAt: Date.now() - 10_000,
    sleepAfterMs: 1_800_000,
    heartbeatIntervalMs: 15_000,
    timeoutRemainingMs: 120_000,
    timeoutSource: "estimated",
    setupProgress: null,
    firewall: {
      mode: "learning",
      allowlist: [],
      learned: [],
      events: [],
      updatedAt: 0,
      lastIngestedAt: null,
      learningStartedAt: null,
      commandsObserved: 0,
      wouldBlock: [],
    },
    channels: CHANNELS_UNCONFIGURED,
    restoreTarget: DEFAULT_STATUS_RESTORE_TARGET,
    lifecycle: DEFAULT_STATUS_LIFECYCLE,
    user: { sub: "admin", name: "Admin" },
    ...overrides,
  };
}

/* ── Status variants ── */

export const STATUS_UNINITIALIZED = makeStatus({
  status: "uninitialized",
  sandboxId: null,
  snapshotId: null,
  gatewayReady: false,
  gatewayStatus: "unknown",
  gatewayCheckedAt: null,
  lastKeepaliveAt: null,
  timeoutRemainingMs: null,
  timeoutSource: "none",
});

export const STATUS_CREATING = makeStatus({
  status: "creating",
  sandboxId: null,
  snapshotId: null,
  gatewayReady: false,
  gatewayStatus: "unknown",
  timeoutRemainingMs: null,
  setupProgress: {
    attemptId: "attempt-1",
    active: true,
    phase: "creating-sandbox",
    phaseLabel: "Creating sandbox",
    startedAt: Date.now() - 5_000,
    updatedAt: Date.now(),
    preview: null,
    lines: [
      { ts: Date.now() - 5_000, stream: "system", text: "Creating sandbox..." },
    ],
  },
});

export const STATUS_SETUP = makeStatus({
  status: "setup",
  sandboxId: "sbx-abc123",
  snapshotId: null,
  gatewayReady: false,
  gatewayStatus: "not-ready",
  timeoutRemainingMs: null,
  setupProgress: {
    attemptId: "attempt-1",
    active: true,
    phase: "installing-openclaw",
    phaseLabel: "Installing OpenClaw",
    startedAt: Date.now() - 30_000,
    updatedAt: Date.now(),
    preview: "openclaw@2026.4.11",
    lines: [
      { ts: Date.now() - 30_000, stream: "system", text: "Sandbox created." },
      { ts: Date.now() - 25_000, stream: "stdout", text: "Installing openclaw@2026.4.11..." },
      { ts: Date.now() - 15_000, stream: "stdout", text: "added 312 packages in 15s" },
      { ts: Date.now() - 10_000, stream: "system", text: "Writing openclaw.json..." },
      { ts: Date.now() - 5_000, stream: "system", text: "Starting gateway..." },
    ],
  },
});

export const STATUS_RUNNING = makeStatus({
  status: "running",
  gatewayReady: true,
  gatewayStatus: "ready",
  timeoutRemainingMs: 1_680_000,
  timeoutSource: "live",
});

export const STATUS_STOPPED = makeStatus({
  status: "stopped",
  gatewayReady: false,
  gatewayStatus: "not-ready",
  gatewayCheckedAt: null,
  lastKeepaliveAt: Date.now() - 3_600_000,
  timeoutRemainingMs: null,
  timeoutSource: "none",
  lifecycle: {
    ...DEFAULT_STATUS_LIFECYCLE,
    lastRestoreMetrics: {
      sandboxCreateMs: 1200,
      tokenWriteMs: 50,
      assetSyncMs: 300,
      startupScriptMs: 800,
      forcePairMs: 200,
      firewallSyncMs: 150,
      localReadyMs: 4500,
      publicReadyMs: 6200,
      totalMs: 8400,
      skippedStaticAssetSync: true,
      assetSha256: "abc123",
      vcpus: 2,
      recordedAt: Date.now() - 3_600_000,
    },
    restoreHistory: [],
  },
});

export const STATUS_ERROR = makeStatus({
  status: "error",
  gatewayReady: false,
  gatewayStatus: "not-ready",
  lastError: "Sandbox crashed: OOM killed (exit code 137). The sandbox ran out of memory during a large operation.",
  timeoutRemainingMs: null,
  timeoutSource: "none",
});

export const STATUS_RESTORING = makeStatus({
  status: "restoring",
  gatewayReady: false,
  gatewayStatus: "not-ready",
  timeoutRemainingMs: null,
  setupProgress: {
    attemptId: "attempt-2",
    active: true,
    phase: "resuming-sandbox",
    phaseLabel: "Restoring snapshot",
    startedAt: Date.now() - 3_000,
    updatedAt: Date.now(),
    preview: null,
    lines: [
      { ts: Date.now() - 3_000, stream: "system", text: "Resuming from snapshot snap-xyz789..." },
    ],
  },
});

export const STATUS_BOOTING = makeStatus({
  status: "booting",
  sandboxId: "sbx-abc123",
  gatewayReady: false,
  gatewayStatus: "not-ready",
  setupProgress: {
    attemptId: "attempt-2",
    active: true,
    phase: "waiting-for-gateway",
    phaseLabel: "Waiting for gateway",
    startedAt: Date.now() - 8_000,
    updatedAt: Date.now(),
    preview: null,
    lines: [
      { ts: Date.now() - 8_000, stream: "system", text: "Sandbox resumed." },
      { ts: Date.now() - 5_000, stream: "system", text: "Starting gateway..." },
      { ts: Date.now() - 2_000, stream: "stdout", text: "Gateway starting on port 3000..." },
    ],
  },
});

/* ── Firewall variants ── */

export const STATUS_FIREWALL_DISABLED = makeStatus({
  firewall: {
    mode: "disabled",
    allowlist: [],
    learned: [],
    events: [],
    updatedAt: 0,
    lastIngestedAt: null,
    learningStartedAt: null,
    commandsObserved: 0,
    wouldBlock: [],
  },
});

export const STATUS_FIREWALL_LEARNING = makeStatus({
  firewall: {
    mode: "learning",
    allowlist: [],
    learned: [
      { domain: "registry.npmjs.org", firstSeenAt: Date.now() - 600_000, lastSeenAt: Date.now() - 60_000, hitCount: 42, categories: ["npm"] },
      { domain: "api.openai.com", firstSeenAt: Date.now() - 500_000, lastSeenAt: Date.now() - 30_000, hitCount: 15, categories: ["fetch"] },
      { domain: "github.com", firstSeenAt: Date.now() - 400_000, lastSeenAt: Date.now() - 120_000, hitCount: 8, categories: ["git"] },
      { domain: "objects.githubusercontent.com", firstSeenAt: Date.now() - 400_000, lastSeenAt: Date.now() - 120_000, hitCount: 3, categories: ["git"] },
      { domain: "dns.google", firstSeenAt: Date.now() - 300_000, lastSeenAt: Date.now() - 200_000, hitCount: 2, categories: ["dns"] },
    ],
    events: [
      { id: "ev-1", timestamp: Date.now() - 60_000, action: "allow", decision: "learning", domain: "registry.npmjs.org", source: "shell", sourceCommand: "npm install express" },
      { id: "ev-2", timestamp: Date.now() - 30_000, action: "allow", decision: "learning", domain: "api.openai.com", source: "shell", sourceCommand: "curl https://api.openai.com/v1/models" },
    ],
    updatedAt: Date.now() - 30_000,
    lastIngestedAt: Date.now() - 30_000,
    learningStartedAt: Date.now() - 600_000,
    commandsObserved: 42,
    wouldBlock: [],
  },
});

export const STATUS_FIREWALL_ENFORCING = makeStatus({
  firewall: {
    mode: "enforcing",
    allowlist: [
      "registry.npmjs.org",
      "api.openai.com",
      "github.com",
      "objects.githubusercontent.com",
      "ai-gateway.vercel.sh",
    ],
    learned: [],
    events: [
      { id: "ev-3", timestamp: Date.now() - 10_000, action: "block", decision: "enforcing", domain: "suspicious.example.com", source: "shell", sourceCommand: "curl https://suspicious.example.com/exfil" },
    ],
    updatedAt: Date.now() - 10_000,
    lastIngestedAt: null,
    learningStartedAt: null,
    commandsObserved: 0,
    wouldBlock: ["suspicious.example.com"],
  },
});

/* ── Channels configured ── */

export const STATUS_CHANNELS_CONFIGURED = makeStatus({
  channels: CHANNELS_CONFIGURED,
});

/* ── No-op callbacks ── */

export const NOOP_RUN_ACTION: RunAction = async () => true;

const successMeta: ActionSuccessMeta = {
  requestId: "dev-noop",
  action: "noop",
  label: "noop",
  status: 200,
  refreshed: false,
};

export const NOOP_REQUEST_JSON: RequestJson = async () => ({
  ok: true as const,
  data: null,
  meta: successMeta,
});

export const NOOP_REFRESH = async () => {};

export const NOOP_READ_DEPS: ReadJsonDeps = {
  setStatus: () => {},
  toastError: () => {},
};

/* ── Mock fetch for panels that read their own data ── */

const MOCK_LOGS: LogEntry[] = [
  { id: "log-1", timestamp: Date.now() - 300_000, level: "info", source: "lifecycle", message: "Sandbox created successfully (sbx-abc123)" },
  { id: "log-2", timestamp: Date.now() - 290_000, level: "info", source: "lifecycle", message: "OpenClaw installed: openclaw@2026.4.11" },
  { id: "log-3", timestamp: Date.now() - 280_000, level: "info", source: "lifecycle", message: "Gateway started on port 3000" },
  { id: "log-4", timestamp: Date.now() - 200_000, level: "info", source: "proxy", message: "Proxying request to /gateway/chat" },
  { id: "log-5", timestamp: Date.now() - 150_000, level: "warn", source: "firewall", message: "Would-block domain in learning mode: suspicious.example.com" },
  { id: "log-6", timestamp: Date.now() - 100_000, level: "info", source: "channels", message: "Telegram webhook registered for @openclaw_bot" },
  { id: "log-7", timestamp: Date.now() - 60_000, level: "error", source: "channels", message: "Slack delivery failed: channel_not_found (C0123ABC)" },
  { id: "log-8", timestamp: Date.now() - 30_000, level: "info", source: "auth", message: "OIDC token refreshed (expires in 3600s)" },
  { id: "log-9", timestamp: Date.now() - 10_000, level: "info", source: "system", message: "Heartbeat: sandbox timeout extended to 1800s" },
];

const MOCK_SNAPSHOTS: SnapshotRecord[] = [
  { id: "snap-1", snapshotId: "snap-xyz789", timestamp: Date.now() - 3_600_000, reason: "stop" },
  { id: "snap-2", snapshotId: "snap-abc456", timestamp: Date.now() - 86_400_000, reason: "manual" },
  { id: "snap-3", snapshotId: "snap-def012", timestamp: Date.now() - 172_800_000, reason: "bootstrap" },
];

const MOCK_FIREWALL_REPORT: FirewallReportPayload = {
  schemaVersion: 1,
  generatedAt: Date.now(),
  state: {
    mode: "learning",
    allowlist: [],
    learned: [
      { domain: "registry.npmjs.org", firstSeenAt: Date.now() - 600_000, lastSeenAt: Date.now() - 60_000, hitCount: 42, categories: ["npm"] },
      { domain: "api.openai.com", firstSeenAt: Date.now() - 500_000, lastSeenAt: Date.now() - 30_000, hitCount: 15, categories: ["fetch"] },
    ],
    events: [],
    updatedAt: Date.now() - 30_000,
    lastIngestedAt: Date.now() - 30_000,
    learningStartedAt: Date.now() - 600_000,
    commandsObserved: 42,
    wouldBlock: [],
    lastSyncAppliedAt: null,
    lastSyncFailedAt: null,
    lastSyncReason: null,
    lastIngestionSkipReason: null,
    ingestionSkipCount: 0,
    lastIngestOutcome: null,
    lastSyncOutcome: null,
  },
  diagnostics: {
    mode: "learning",
    learningHealth: {
      durationMs: 600_000,
      commandsObserved: 42,
      uniqueDomains: 5,
      lastIngestedAt: Date.now() - 30_000,
      stalenessMs: 30_000,
    },
    syncStatus: {
      lastAppliedAt: null,
      lastFailedAt: null,
      lastReason: null,
    },
    ingestionStatus: {
      lastSkipReason: null,
      consecutiveSkips: 0,
    },
    wouldBlockCount: 0,
  },
  groupedLearned: [
    {
      registrableDomain: "npmjs.org",
      domains: [
        { domain: "registry.npmjs.org", firstSeenAt: Date.now() - 600_000, lastSeenAt: Date.now() - 60_000, hitCount: 42, categories: ["npm"] },
      ],
    },
    {
      registrableDomain: "openai.com",
      domains: [
        { domain: "api.openai.com", firstSeenAt: Date.now() - 500_000, lastSeenAt: Date.now() - 30_000, hitCount: 15, categories: ["fetch"] },
      ],
    },
  ],
  wouldBlock: [],
  lastIngest: null,
  lastSync: null,
  limitations: [],
  policyHash: "mock-hash",
};

const mockFetch: typeof fetch = async (input) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;

  if (url.includes("/api/admin/logs")) {
    return Response.json({ logs: MOCK_LOGS });
  }
  if (url.includes("/api/admin/snapshots")) {
    return Response.json({ snapshots: MOCK_SNAPSHOTS });
  }
  if (url.includes("/api/firewall/report")) {
    return Response.json(MOCK_FIREWALL_REPORT);
  }
  return new Response("Not found", { status: 404 });
};

export const MOCK_READ_DEPS: ReadJsonDeps = {
  setStatus: () => {},
  toastError: () => {},
  fetchFn: mockFetch,
};
