---
name: vercel-openclaw-testing
description: Testing guide for the vercel-openclaw project (single Next.js 16 app at vercel-labs/vercel-openclaw). Covers the scenario harness, fake sandbox controller, fake fetch, route callers, auth fixtures, webhook builders, assertion helpers, full smoke test patterns, mock patterns for each subsystem, and the complete verification protocol. Use when writing tests, debugging failures, or verifying work in the vercel-openclaw repo.
metadata:
  filePattern:
    - "**/vercel-openclaw/**/*.test.ts"
    - "**/vercel-openclaw/**/*.test.tsx"
    - "**/vercel-openclaw/src/server/**"
    - "**/vercel-openclaw/src/test-utils/**"
  bashPattern:
    - "npm test"
    - "npm run test:watch"
    - "node scripts/verify.mjs"
---

# vercel-openclaw Testing

Full testing playbook for `vercel-openclaw` — a single Next.js 16 App Router project deployed to Vercel.

## Quick Reference

```bash
# Canonical local verification (use this for CI and agent verification)
node scripts/verify.mjs                                     # all gates
node scripts/verify.mjs --steps=test                        # test only
node scripts/verify.mjs --steps=lint                        # lint only
node scripts/verify.mjs --steps=typecheck                   # typecheck only
node scripts/verify.mjs --steps=build                       # build only
node scripts/verify.mjs --steps=test,typecheck              # multiple steps

# Direct npm shortcuts (convenience only — prefer verify.mjs for automation)
npm test                                                    # all tests
npm run test:watch                                          # watch mode
```

## Remote Deployment Readiness Gate

Before connecting Slack, Telegram, or Discord, verify the deployment meets the launch contract. The readiness verifier checks `/api/admin/preflight` and fails unless `ok=true`, `storeBackend=upstash`, and `aiGatewayAuth=oidc`.

```bash
# Readiness check (reads secrets from env — never hardcode them)
OPENCLAW_BASE_URL="$OPENCLAW_BASE_URL" \
VERCEL_AUTOMATION_BYPASS_SECRET="$VERCEL_AUTOMATION_BYPASS_SECRET" \
node scripts/check-deploy-readiness.mjs --json-only

# With explicit flags
node scripts/check-deploy-readiness.mjs \
  --base-url "$OPENCLAW_BASE_URL" \
  --protection-bypass "$VERCEL_AUTOMATION_BYPASS_SECRET" \
  --json-only
```

**Exit codes:** 0=pass, 1=contract-fail, 2=bad-args, 3=fetch-fail, 4=bad-response.

**Rule: Do not connect channels until the readiness verifier exits 0.**

## Remote Smoke Testing (Live Deployment)

Run smoke tests only after the readiness gate passes. All secrets must come from environment variables.

```bash
# Safe read-only smoke test
npm run smoke:remote -- \
  --base-url "$OPENCLAW_BASE_URL" \
  --protection-bypass "$VERCEL_AUTOMATION_BYPASS_SECRET"

# Destructive smoke test (includes ensure, snapshot, restore — use with caution)
npm run smoke:remote -- \
  --base-url "$OPENCLAW_BASE_URL" \
  --protection-bypass "$VERCEL_AUTOMATION_BYPASS_SECRET" \
  --destructive --timeout 180

# JSON-only output (for CI)
npm run smoke:remote -- \
  --base-url "$OPENCLAW_BASE_URL" \
  --protection-bypass "$VERCEL_AUTOMATION_BYPASS_SECRET" \
  --json-only
```

**Auth flags:**
- `--protection-bypass` — reads from flag or `VERCEL_AUTOMATION_BYPASS_SECRET` env var
- `--auth-cookie` — reads from flag or `SMOKE_AUTH_COOKIE` env var
- **Never commit or hardcode secrets in docs, code samples, or tests**

**Ad-hoc endpoint checks with `vercel curl`:**
```bash
vercel curl /api/health --deployment "$OPENCLAW_BASE_URL"
vercel curl /api/status --deployment "$OPENCLAW_BASE_URL"
```

## Test Framework

- **Runner:** `node:test` (Node.js built-in)
- **Assertions:** `node:assert/strict`
- **Transpiler:** `tsx` (TypeScript execution)
- **NO Jest, NO Vitest** — native Node testing only
- **Test command:** `npm test` or `node scripts/verify.mjs --steps=test`
- **Imports:** `@/` path alias (mapped to `src/` in tsconfig)

Tests are **colocated** with source files. Route tests live next to route files. Server tests live next to server modules. The full smoke test lives at `src/server/smoke/full-smoke.test.ts`.

---

## Scenario Harness

The harness (`src/test-utils/harness.ts`) is the central test scaffold. It wires together a fake sandbox controller, fake fetch, isolated store, log collector, and env overrides.

### `createScenarioHarness(options?)`

```typescript
import { createScenarioHarness } from "@/test-utils/harness";

const h = createScenarioHarness();
try {
  // h.controller  — FakeSandboxController
  // h.fakeFetch   — FakeFetch (intercepts all network calls)
  // h.log         — LogCollector (structured logs for observability)
  // h.getMeta()   — read current SingleMeta from store
  // h.mutateMeta  — mutate metadata in store
  // h.getStore    — get the store instance
  // h.captureState() — snapshot of current state for assertions
  // h.teardown()  — reset singletons, env, store
} finally {
  h.teardown();
}
```

**Options:**
- `controllerDelay?: number` — ms delay for fake sandbox operations
- `authMode?: 'deployment-protection' | 'sign-in-with-vercel' | 'none'`

### `withHarness(fn, options?)`

Convenience wrapper with auto-teardown:

```typescript
import { withHarness } from "@/test-utils/harness";

test("my scenario", () =>
  withHarness(async (h) => {
    h.fakeFetch.onGet(/openclaw-app/, () => gatewayReadyResponse());
    const meta = await h.getMeta();
    assert.equal(meta.status, "uninitialized");
  })
);
```

### `ScenarioHarness` Full Type

```typescript
type ScenarioHarness = {
  controller: FakeSandboxController;
  fakeFetch: FakeFetch;
  log: LogCollector;
  getMeta: () => Promise<SingleMeta>;
  mutateMeta: typeof mutateMeta;
  getStore: typeof getStore;
  captureState: () => Promise<StateSnapshot>;
  teardown: () => void;

  // Observability formatters
  formatTimeline(): string;
  formatQueues(): Promise<string>;
  formatLastRequests(n?: number): string;
  formatRecentLogs(n?: number): string;

  // Shared scenario helpers
  driveToRunning(): Promise<void>;
  stopToSnapshot(): Promise<string>;
  configureAllChannels(): ChannelSecrets;
  installDefaultGatewayHandlers(gatewayReply?: string): void;
};
```

### Shared Scenario Helpers

| Helper | Description |
|--------|-------------|
| `h.driveToRunning()` | Drives sandbox from current state to `running`. Installs gateway-ready handler, triggers `ensureSandboxRunning`, executes background callback, probes readiness. |
| `h.stopToSnapshot()` | Stops sandbox, asserts `status=stopped` and `snapshotId` present. Returns the snapshotId. |
| `h.configureAllChannels()` | Configures Slack, Telegram, Discord with test credentials. Returns `{ slackSigningSecret, telegramWebhookSecret, discordPublicKeyHex, discordPrivateKey }`. |
| `h.installDefaultGatewayHandlers(reply?)` | Registers fetch handlers for: gateway completions, all platform APIs, gateway readiness, Slack thread history. |

### Observability Formatters

| Formatter | Output |
|-----------|--------|
| `h.formatTimeline()` | Controller events + HTTP requests + log entries interleaved by timestamp |
| `h.formatQueues()` | Queue depths for all channels: `slack: queue=0 processing=0` |
| `h.formatLastRequests(n)` | Last N captured HTTP requests (method + URL + auth flag) |
| `h.formatRecentLogs(n)` | Last N log entries (level + message + data) |

### `dumpDiagnostics(t, h)` — Failure Diagnostics

Call in a `catch` block to dump full observability output via `t.diagnostic()`:

```typescript
test("my test", async (t) => {
  const h = createScenarioHarness();
  try {
    // ... test body ...
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    h.teardown();
  }
});
```

Dumps: timeline, queue depths, last 10 HTTP requests, last 30 log entries.

---

## FakeSandboxController & FakeSandboxHandle

`src/test-utils/fake-sandbox-controller.ts` provides a complete mock of the `@vercel/sandbox` API.

### FakeSandboxController

```typescript
const h = createScenarioHarness();
const ctrl = h.controller;

ctrl.created;                    // FakeSandboxHandle[] — all created handles
ctrl.retrieved;                  // string[] — all retrieved sandbox IDs
ctrl.handlesByIds;               // Map<string, FakeSandboxHandle>
ctrl.events;                     // SandboxEvent[] — ordered event log

ctrl.lastCreated();              // most recently created handle
ctrl.getHandle(sandboxId);       // get by ID (undefined if not tracked)
ctrl.eventsOfKind("create");     // filter events by kind
```

**Event Kinds:** `create` | `snapshot` | `restore` | `command` | `write_files` | `extend_timeout` | `update_network_policy`

### FakeSandboxHandle

Each handle tracks everything done to it:

```typescript
const handle = ctrl.lastCreated()!;

handle.sandboxId;               // string
handle.commands;                 // Array<{ cmd: string; args?: string[] }>
handle.writtenFiles;             // Array<{ path: string; content: Buffer }>
handle.networkPolicies;          // NetworkPolicy[]
handle.extendedTimeouts;         // number[]
handle.snapshotCalled;           // boolean

// Scripted command responses (checked in order, first non-undefined wins)
handle.responders.push((cmd, args) => {
  if (cmd === "cat") return { exitCode: 0, output: async () => "file content" };
  return undefined;
});

// Methods (all async)
await handle.runCommand("ls", ["-la"]);
await handle.writeFiles([{ path: "/tmp/test", content: Buffer.from("data") }]);
await handle.snapshot();         // Returns { snapshotId: "snap-{sandboxId}" }
await handle.extendTimeout(300_000);
await handle.updateNetworkPolicy({ allow: ["example.com"] });
```

---

## FakeFetch

`src/test-utils/fake-fetch.ts` intercepts all `globalThis.fetch` calls during tests.

### API

```typescript
const h = createScenarioHarness();
const ff = h.fakeFetch;

ff.onGet(pattern, handler);      // Register GET handler
ff.onPost(pattern, handler);     // Register POST handler
ff.onPatch(pattern, handler);    // Register PATCH handler
ff.on("PUT", pattern, handler);  // Register any method handler
ff.otherwise(handler);           // Fallback for unmatched requests
ff.requests();                   // CapturedRequest[] — all requests made
ff.reset();                      // Clear all handlers and captured requests
```

`pattern` is a `string | RegExp`. Strings match as substring. Regex matches against the full URL.

### Preset Responses

```typescript
import {
  gatewayReadyResponse,
  gatewayNotReadyResponse,
  slackOkResponse,
  telegramOkResponse,
  discordOkResponse,
  chatCompletionsResponse,
} from "@/test-utils/fake-fetch";

ff.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());
ff.onPost("https://slack.com/api/chat.postMessage", () => slackOkResponse());
ff.onPost(/api\.telegram\.org/, () => telegramOkResponse());
ff.onPost(/discord\.com\/api/, () => discordOkResponse());
ff.onPost(/v1\/chat\/completions/, () => chatCompletionsResponse("Hello!"));
```

### CapturedRequest Type

```typescript
type CapturedRequest = {
  url: string;
  method: string;
  body?: string;
  headers?: Record<string, string>;
};
```

---

## Assertion Helpers

`src/test-utils/assertions.ts` provides reusable multi-step assertion functions.

### `assertGatewayRequest(requests, options)`

Assert that a `/v1/chat/completions` request was made with the correct Bearer token:

```typescript
import { assertGatewayRequest } from "@/test-utils/assertions";

const gw = assertGatewayRequest(h.fakeFetch.requests(), {
  gatewayToken: meta.gatewayToken,
  sessionKey: "slack:C123:1234.5678",  // optional
  minCalls: 1,                          // default: 1
  userMessage: "hello",                 // optional: verify last message
});
```

### `assertQueuesDrained(store, channel, options?)`

Assert queue, processing, and dead-letter queues are at expected lengths (default: 0):

```typescript
import { assertQueuesDrained } from "@/test-utils/assertions";

await assertQueuesDrained(store, "slack");
await assertQueuesDrained(store, "slack", { queue: 0, processing: 0, deadLetter: 0 });
```

### `assertHistory(history, expected)`

Assert session history contains expected messages in order:

```typescript
import { assertHistory } from "@/test-utils/assertions";

assertHistory(history, [
  { role: "user", content: "hello" },
  { role: "assistant", content: (c) => assert.ok(c.includes("Hi")) },
]);
```

### `assertNoBrowserAuthTraffic(requests)`

Assert no requests to Vercel OAuth token exchange or authorize endpoints:

```typescript
import { assertNoBrowserAuthTraffic } from "@/test-utils/assertions";

assertNoBrowserAuthTraffic(h.fakeFetch.requests());
```

---

## Route Caller Helpers

`src/test-utils/route-caller.ts` provides helpers for invoking Next.js route handlers in tests.

### Core Functions

```typescript
import {
  callRoute,
  callGatewayGet,
  callGatewayMethod,
  callAdminPost,
  drainAfterCallbacks,
  resetAfterCallbacks,
  pendingAfterCount,
  patchNextServerAfter,
} from "@/test-utils/route-caller";
```

**`patchNextServerAfter()`** — Must be called before importing route modules. Patches `next/server` so `after()` callbacks are captured instead of executed immediately.

**`callRoute(handler, request)`** — Invoke a route handler, returns:

```typescript
type RouteCallResult = {
  response: Response;
  status: number;
  json: unknown;   // parsed JSON body or null
  text: string;    // raw body text
};
```

**`drainAfterCallbacks()`** — Execute all captured `after()` callbacks. Call this after route invocations to run background work (lifecycle transitions, queue draining, etc.).

**`pendingAfterCount()`** — Number of unexecuted callbacks. Useful for asserting all background work completed.

### Request Builders

```typescript
import {
  buildGetRequest,
  buildPostRequest,
  buildPutRequest,
  buildAuthGetRequest,
  buildAuthPostRequest,
  buildAuthPutRequest,
} from "@/test-utils/route-caller";
```

- `buildGetRequest(path, headers?)` — plain GET to `http://localhost:3000`
- `buildPostRequest(path, body, headers?)` — POST with `content-type: application/json`
- `buildAuthPostRequest(path, body, headers?)` — POST with CSRF headers (`origin`, `x-requested-with`)
- `buildAuthGetRequest(path, headers?)` — GET with CSRF headers
- Auth variants add `origin: http://localhost:3000` and `x-requested-with: XMLHttpRequest`

### Lazy Route Loaders

```typescript
import {
  getGatewayRoute,
  getHealthRoute,
  getStatusRoute,
  getAdminEnsureRoute,
  getAdminStopRoute,
  getAdminSnapshotRoute,
  getAdminSnapshotsRoute,
  getAdminSshRoute,
  getAdminLogsRoute,
  getFirewallRoute,
  getFirewallTestRoute,
  getSlackWebhookRoute,
  getTelegramWebhookRoute,
  getDiscordWebhookRoute,
  getCronDrainRoute,
  getChannelsSummaryRoute,
} from "@/test-utils/route-caller";
```

These lazy-load route modules after harness setup to ensure mocks are in place.

---

## Auth Fixtures

`src/test-utils/auth-fixtures.ts` provides helpers for both auth modes.

### Session Cookie (sign-in-with-vercel mode)

```typescript
import {
  buildSessionCookie,
  setCookieToCookieHeader,
  SIGN_IN_ENV,
} from "@/test-utils/auth-fixtures";

const setCookie = await buildSessionCookie({
  user: { name: "Test User", email: "test@example.com" },
  accessToken: "test-access-token",
  refreshToken: "test-refresh-token",
  expiresAt: Date.now() + 3600_000,
});

const cookieHeader = setCookieToCookieHeader(setCookie);
const request = buildAuthGetRequest("/api/status", { cookie: cookieHeader });
```

### Deployment Protection Headers

```typescript
import {
  buildDeploymentProtectionHeaders,
  DEPLOYMENT_PROTECTION_ENV,
} from "@/test-utils/auth-fixtures";

const headers = buildDeploymentProtectionHeaders();
// { "x-vercel-protection-bypass": "true", "x-forwarded-proto": "https" }
```

### Environment Presets

```typescript
// SIGN_IN_ENV — sets VERCEL_AUTH_MODE=sign-in-with-vercel + required OAuth vars
// DEPLOYMENT_PROTECTION_ENV — sets VERCEL_AUTH_MODE=deployment-protection
```

---

## Webhook Builders

`src/test-utils/webhook-builders.ts` constructs correctly signed webhook requests for each platform.

### Slack

```typescript
import { buildSlackWebhook, buildSlackUrlVerification } from "@/test-utils/webhook-builders";

const webhook = buildSlackWebhook({
  signingSecret: "test-signing-secret",
  payload: { event: { type: "app_mention", text: "hello", channel: "C123", ts: "1234.5678" } },
});
// Returns a Request with valid x-slack-signature and x-slack-request-timestamp

const verify = buildSlackUrlVerification("test-signing-secret", "challenge-token");
```

### Telegram

```typescript
import { buildTelegramWebhook } from "@/test-utils/webhook-builders";

const webhook = buildTelegramWebhook({
  webhookSecret: "test-secret",
  payload: { message: { chat: { id: 123 }, text: "/ask hello", from: { id: 456 } } },
});
// Returns a Request with x-telegram-bot-api-secret-token header
```

### Discord

```typescript
import {
  buildDiscordWebhook,
  buildDiscordPing,
  generateDiscordKeyPair,
} from "@/test-utils/webhook-builders";

const keys = generateDiscordKeyPair();
// { privateKey: KeyObject, publicKeyHex: string }

const webhook = buildDiscordWebhook({
  privateKey: keys.privateKey,
  publicKeyHex: keys.publicKeyHex,
  payload: { type: 2, data: { name: "ask", options: [{ value: "hello" }] } },
});

const ping = buildDiscordPing(keys);
```

---

## Full Smoke Test

`src/server/smoke/full-smoke.test.ts` is the canonical end-to-end integration test. It exercises the complete lifecycle of the app in a single sequential test with 8 phases.

### Smoke Test Phases

| Phase | Name | What it verifies |
|-------|------|-----------------|
| 1 | Harness setup | All 3 channels configured, firewall set to learning mode, default gateway handlers installed |
| 2 | Fresh create + bootstrap | `uninitialized → creating → setup → running`, bootstrap artifacts written, one sandbox created |
| 3 | Proxy verification | HTML injection contains script tag, WS rewrite, heartbeat URL, base tag, referrer policy, token only inside `<script>` |
| 4 | Firewall learning + enforce | Ingest domains from learning log, approve to allowlist, switch to enforcing, network policy applied to sandbox |
| 5 | Snapshot stop | `running → stopped`, snapshotId present with `snap-` prefix, snapshot history updated, controller events correct |
| 6 | Channel-triggered restore | Slack+Telegram enqueued while stopped, Slack drain triggers exactly one restore, Telegram drain reuses running sandbox, both queues clean |
| 7 | Already-running Discord | Discord enqueued and drained without triggering restore, gateway request verified, Discord API called |
| 8 | Final invariants | All queues empty (including dead-letter), lifecycle sequence is `create → snapshot → restore`, timestamps monotonic, exactly 2 sandboxes created, 1 restore, no error logs, firewall still enforcing, channels still configured |

### Smoke Test Architecture

```
test("full-smoke: complete lifecycle", async (t) => {
  const h = createScenarioHarness();
  try {
    await t.test("Phase 1: ...", async () => { ... });
    await t.test("Phase 2: ...", async () => { ... });
    // ... phases 3-8 ...
  } catch (err) {
    await dumpDiagnostics(t, h);  // Full observability dump on failure
    throw err;
  } finally {
    h.teardown();
  }
});
```

Key design decisions:
- **Single harness** shared across all phases — state accumulates naturally
- **Subtests** (`t.test()`) give per-phase pass/fail visibility
- **`dumpDiagnostics`** on catch — timeline, queues, requests, logs all dumped on any failure
- **`globalThis.fetch` swap** — phases that need fetch set it and restore it in try/finally
- **Command responders** for firewall learning — scripted sandbox output for domain extraction

### Adding a New Smoke Test Phase

1. Add a new `await t.test("Phase N: description", async () => { ... })` inside the main test
2. The harness `h` is shared — previous phases' state is available
3. Use `h.log.info("phase-N-complete")` at the end for timeline visibility
4. Assert both the expected outcome AND that no regressions occurred (e.g., `assertNoBrowserAuthTraffic`)

---

## Mock Patterns by Subsystem

### Sandbox Lifecycle Mocking

The `FakeSandboxController` automatically handles lifecycle operations:

```typescript
// Create drives through: ensureSandboxRunning → schedule callback → execute → probe
await h.driveToRunning();

// Stop + snapshot
const snapshotId = await h.stopToSnapshot();

// Manual lifecycle with schedule capture
let scheduledCallback: (() => Promise<void> | void) | null = null;
const result = await ensureSandboxRunning({
  origin: "https://test.example.com",
  reason: "test",
  schedule(cb) { scheduledCallback = cb; },
});
await scheduledCallback!();
```

### Channel Mocking

```typescript
// Configure all channels at once
const secrets = h.configureAllChannels();

// Install default handlers (gateway + all platform APIs)
h.installDefaultGatewayHandlers("Custom reply");

// Enqueue jobs directly (bypassing webhook routes)
await enqueueChannelJob("slack", {
  payload: slackPayload,
  receivedAt: Date.now(),
  origin: "https://test.example.com",
});

// Drain specific channel
await drainSlackQueue();
await drainTelegramQueue();
await drainDiscordQueue();
```

### Firewall Mocking

```typescript
// Set mode via meta mutation (low-level)
await h.mutateMeta((m) => { m.firewall.mode = "learning"; });

// Set mode via state API (triggers sync)
await setFirewallMode("enforcing");

// Script learning log output in sandbox
const handle = h.controller.lastCreated()!;
handle.responders.push((cmd, args) => {
  if (cmd === "bash" && args?.some((a) => a.includes("shell-commands-for-learning"))) {
    return { exitCode: 0, output: async () => "curl https://api.example.com\n" };
  }
  return undefined;
});

// Ingest + approve + enforce
await ingestLearningFromSandbox(true);
await approveDomains(["api.example.com"]);
await setFirewallMode("enforcing");

// Verify network policy was applied
assert.ok(handle.networkPolicies.length >= 1);
```

### Proxy / HTML Injection Mocking

```typescript
import { injectWrapperScript } from "@/server/proxy/htmlInjection";

const injected = injectWrapperScript(rawHtml, {
  sandboxOrigin: "https://sbx-fake-1-3000.fake.vercel.run",
  gatewayToken: meta.gatewayToken,
});

// Assert injection markers
assert.ok(injected.includes("WebSocket"));
assert.ok(injected.includes("openclaw.gateway-token"));
assert.ok(injected.includes('<base href="/gateway/">'));
```

### Store Mocking

The harness automatically uses the in-memory store. For queue operations:

```typescript
const store = h.getStore();

// Check queue depths
const depth = await store.getQueueLength(channelQueueKey("slack"));

// Use assertion helpers
await assertQueuesDrained(store, "slack");
await assertQueuesDrained(store, "telegram", { deadLetter: 0 });
```

---

## Test Taxonomy

Tests in this project fall into four categories. Each serves a different purpose and uses different infrastructure.

| Category | Purpose | Harness? | Route Caller? | Example |
|----------|---------|----------|---------------|---------|
| **Unit** | Verify a single function or module in isolation | No (or minimal) | No | `domains.test.ts`, `config.test.ts`, `csrf.test.ts` |
| **Route / Contract** | Verify HTTP routes: status codes, response shapes, auth enforcement, CSRF, request validation | Yes | Yes (`callRoute` + `drainAfterCallbacks`) | `route.test.ts` files, `auth-enforcement.test.ts` |
| **Integration / Scenario** | Verify cross-subsystem flows: lifecycle + channels, drain + restore, firewall + sandbox | Yes | Sometimes | `scenarios.test.ts`, `drain-lifecycle.test.ts` |
| **Smoke** | End-to-end sequential lifecycle exercising every subsystem in a single harness | Yes | No (calls functions directly) | `full-smoke.test.ts` |
| **Failure** | Verify error paths: create failure, bootstrap timeout, API errors, retry exhaustion, dead-letter | Yes | Sometimes | Uses `FakeSandboxController` responders + `FakeFetch.otherwise()` |

### When to use which

- **Unit** when the function is pure or has minimal dependencies (domains, config generation, CSRF validation, env parsing).
- **Route / Contract** when testing the HTTP boundary: auth gates, CSRF enforcement, response status/shape, `after()` background work.
- **Integration / Scenario** when the test needs multiple subsystems wired together but does not need the full lifecycle.
- **Smoke** when verifying the complete lifecycle from `uninitialized` to `running` to `stopped` and back.
- **Failure** when verifying error handling, retry behavior, dead-letter routing, or graceful degradation.

---

## Coverage Matrix

Every source module and its corresponding test file(s). Status indicates coverage depth.

### API Routes

| Source Module | Test File(s) | Status | Notes |
|--------------|-------------|--------|-------|
| `src/app/api/health/route.ts` | `src/app/api/health/route.test.ts` | Tested | Unauthenticated 200 |
| `src/app/api/status/route.ts` | `src/app/api/status/route.test.ts` | Tested | GET/POST, CSRF, heartbeat touch |
| `src/app/api/admin/ensure/route.ts` | `src/app/api/admin/admin-lifecycle.test.ts` | Tested | Auth + lifecycle trigger |
| `src/app/api/admin/stop/route.ts` | `src/app/api/admin/admin-lifecycle.test.ts` | Tested | Auth + stop flow |
| `src/app/api/admin/snapshot/route.ts` | `src/app/api/admin/snapshot/route.test.ts` | Tested | Snapshot-and-stop |
| `src/app/api/admin/snapshots/route.ts` | `src/app/api/admin/snapshots/route.test.ts` | Tested | List snapshots |
| `src/app/api/admin/snapshots/restore/route.ts` | `src/app/api/admin/admin-lifecycle.test.ts` | Tested | Restore from snapshot |
| `src/app/api/admin/ssh/route.ts` | `src/app/api/admin/ssh/route.test.ts` | Tested | SSH session |
| `src/app/api/admin/logs/route.ts` | `src/app/api/admin/logs/route.test.ts` | Tested | Log streaming |
| `src/app/api/auth/authorize/route.ts` | `src/app/api/auth/auth-routes.test.ts` | Tested | OAuth redirect |
| `src/app/api/auth/callback/route.ts` | `src/app/api/auth/auth-routes.test.ts` | Tested | Token exchange |
| `src/app/api/auth/signout/route.ts` | `src/app/api/auth/auth-routes.test.ts` | Tested | Session clear |
| `src/app/api/firewall/route.ts` | `src/app/api/firewall/route.test.ts` | Tested | GET/PUT firewall status |
| `src/app/api/firewall/test/route.ts` | `src/app/api/firewall/test/route.test.ts` | Tested | Firewall test endpoint |
| `src/app/api/firewall/allowlist/route.ts` | `src/app/api/admin-firewall-routes.test.ts` | Tested | Allowlist CRUD |
| `src/app/api/firewall/promote/route.ts` | `src/app/api/admin-firewall-routes.test.ts` | Tested | Promote to enforcing |
| `src/app/api/channels/summary/route.ts` | `src/app/api/channels/summary/route.test.ts` | Tested | Queue counts, config |
| `src/app/api/channels/slack/webhook/route.ts` | `src/server/channels/slack/route.test.ts` | Tested | Signature validation |
| `src/app/api/channels/slack/route.ts` | `src/server/channels/slack/route.test.ts` | Tested | Slack config admin |
| `src/app/api/channels/slack/manifest/route.ts` | `src/app/api/channels/slack/manifest/route.test.ts` | Tested | Slack manifest generation |
| `src/app/api/channels/slack/test/route.ts` | `src/app/api/channels/slack/test/route.test.ts` | Tested | Slack test endpoint |
| `src/app/api/channels/telegram/webhook/route.ts` | `src/server/channels/telegram/route.test.ts` | Tested | Secret validation |
| `src/app/api/channels/telegram/route.ts` | `src/server/channels/telegram/route.test.ts` | Tested | Telegram config admin |
| `src/app/api/channels/telegram/preview/route.ts` | `src/app/api/channels/telegram/preview/route.test.ts` | Tested | Telegram preview |
| `src/app/api/channels/discord/webhook/route.ts` | `src/server/channels/discord/route.test.ts` | Tested | Ed25519 + PING |
| `src/app/api/channels/discord/route.ts` | `src/server/channels/discord/route.test.ts` | Tested | Discord config admin |
| `src/app/api/channels/discord/register-command/route.ts` | `src/app/api/channels/discord/register-command/route.test.ts` | Tested | `/ask` registration |
| `src/app/api/cron/drain-channels/route.ts` | `src/app/api/cron/drain-channels/route.test.ts` | Tested | CRON_SECRET, drain all |
| `src/app/gateway/[[...path]]/route.ts` | `src/app/gateway/route.test.ts` | Tested | Auth, waiting page, injection, WS rewrite |

### Server Modules

| Source Module | Test File(s) | Status | Notes |
|--------------|-------------|--------|-------|
| **Auth** | | | |
| `src/server/auth/csrf.ts` | `src/server/auth/csrf.test.ts` | Tested | Origin + header validation |
| `src/server/auth/session.ts` | `src/server/auth/session.test.ts` | Tested | Cookie encrypt/decrypt |
| `src/server/auth/vercel-auth.ts` | `src/server/auth/vercel-auth.test.ts` | Tested | JWKS, token exchange, refresh |
| `src/server/auth/route-auth.ts` | `src/app/api/auth/auth-enforcement.test.ts` | Tested | Auth middleware for routes |
| **Channels** | | | |
| `src/server/channels/driver.ts` | `src/server/channels/driver.test.ts` | Tested | Dedup, drain lock, malformed jobs, retry |
| `src/server/channels/state.ts` | `src/server/channels/state.test.ts` | Tested | Channel state management |
| `src/server/channels/history.ts` | `src/server/channels/history.test.ts` | Tested | Conversation history |
| `src/server/channels/keys.ts` | `src/server/channels/keys.test.ts` | Tested | Queue key helpers |
| `src/server/channels/core/reply.ts` | `src/server/channels/core/reply.test.ts` | Tested | Reply formatting core |
| `src/server/channels/core/types.ts` | — | N/A | Type definitions only |
| `src/server/channels/slack/adapter.ts` | `src/server/channels/slack/adapter.test.ts` | Tested | Thread replies, formatting |
| `src/server/channels/slack/runtime.ts` | `src/server/channels/slack/runtime.test.ts`, `drain.test.ts` | Tested | Runtime behavior + drain |
| `src/server/channels/telegram/adapter.ts` | `src/server/channels/telegram/adapter.test.ts` | Tested | Message routing |
| `src/server/channels/telegram/bot-api.ts` | `src/server/channels/telegram/bot-api.test.ts` | Tested | Bot API helpers |
| `src/server/channels/telegram/runtime.ts` | `src/server/channels/telegram/runtime.test.ts`, `drain.test.ts` | Tested | Runtime behavior + drain |
| `src/server/channels/discord/adapter.ts` | `src/server/channels/discord/adapter.test.ts` | Tested | Deferred responses |
| `src/server/channels/discord/application.ts` | `src/server/channels/discord/application.test.ts` | Tested | Discord application setup |
| `src/server/channels/discord/discord-api.ts` | `src/server/channels/discord/discord-api.test.ts` | Tested | API helpers |
| `src/server/channels/discord/runtime.ts` | `src/server/channels/discord/runtime.test.ts`, `drain.test.ts` | Tested | Runtime behavior + drain |
| **Firewall** | | | |
| `src/server/firewall/domains.ts` | `src/server/firewall/domains.test.ts` | Tested | Extraction, normalization, dedup |
| `src/server/firewall/policy.ts` | `src/server/firewall/state.test.ts` | Tested | Mode mapping contract |
| `src/server/firewall/state.ts` | `src/server/firewall/state.test.ts`, `firewall-sync.test.ts` | Tested | Mode transitions, learning |
| **Sandbox & Lifecycle** | | | |
| `src/server/sandbox/lifecycle.ts` | `src/server/sandbox/lifecycle.test.ts`, `scenarios.test.ts`, `route-scenarios.test.ts` | Tested | State machine, transitions |
| `src/server/sandbox/controller.ts` | — | N/A | Production wrapper for `@vercel/sandbox` (mocked by `FakeSandboxController`) |
| **OpenClaw** | | | |
| `src/server/openclaw/bootstrap.ts` | `src/server/openclaw/bootstrap.test.ts` | Tested | Install, config write, gateway health |
| `src/server/openclaw/config.ts` | `src/server/openclaw/config.test.ts` | Tested | Config generation |
| **Proxy** | | | |
| `src/server/proxy/htmlInjection.ts` | `src/server/proxy/htmlInjection.test.ts` | Tested | Script injection, WS rewrite |
| `src/server/proxy/proxy-route-utils.ts` | `src/server/proxy/proxy-route-utils.test.ts` | Tested | Path traversal, sanitization |
| `src/server/proxy/waitingPage.ts` | `src/server/proxy/waitingPage.test.ts` | Tested | Waiting page HTML |
| **Store** | | | |
| `src/server/store/store.ts` | `src/server/store/store.test.ts` | Tested | Backend selection, metadata shape |
| `src/server/store/memory-store.ts` | `src/server/store/store.test.ts` | Tested | Used by all test harnesses |
| `src/server/store/upstash-store.ts` | — | Untested | Production-only; same interface as memory |
| **Other** | | | |
| `src/server/env.ts` | `src/server/env.test.ts` | Tested | Env variable validation |
| `src/server/log.ts` | `src/server/log.test.ts` | Tested | Structured logger contract |

### Cross-cutting / Integration

| Test File | Category | Covers |
|-----------|----------|--------|
| `src/server/smoke/full-smoke.test.ts` | Smoke | Full 8-phase lifecycle: create, proxy, firewall, stop, restore, channels, invariants |
| `src/server/sandbox/scenarios.test.ts` | Integration | Lifecycle + channels end-to-end |
| `src/server/sandbox/route-scenarios.test.ts` | Integration | Route-level lifecycle flows |
| `src/server/channels/drain.test.ts` | Integration | Queue draining across all platforms |
| `src/server/channels/drain-retry.test.ts` | Failure | Retry behavior for failed drains |
| `src/server/channels/drain-lifecycle.test.ts` | Integration | Drain triggers sandbox restore |
| `src/server/channels/drain-auth-decay.test.ts` | Failure | Auth token expiry during drain |
| `src/test-utils/harness-isolation.test.ts` | Unit | Harness teardown correctness |

### Coverage Gaps (untested source modules)

All source modules now have direct test coverage. The only remaining indirectly-tested files are:

| Module | Risk | Status |
|--------|------|--------|
| `src/server/store/upstash-store.ts` | Low | Same interface as memory-store; integration-tested via `store.test.ts`. Network behavior requires live Upstash. |

Previously listed gaps that are now covered:

- `src/app/api/channels/slack/route.ts` → `slack/route.test.ts` ✅
- `src/app/api/channels/slack/manifest/route.ts` → `channels/slack/manifest/route.test.ts` ✅
- `src/app/api/channels/slack/test/route.ts` → `channels/slack/test/route.test.ts` ✅
- `src/app/api/channels/telegram/route.ts` → `telegram/route.test.ts` ✅
- `src/app/api/channels/telegram/preview/route.ts` → `channels/telegram/preview/route.test.ts` ✅
- `src/app/api/channels/discord/route.ts` → `discord/route.test.ts` ✅
- `src/app/api/channels/discord/register-command/route.ts` → `channels/discord/register-command/route.test.ts` ✅
- `src/server/channels/discord/application.ts` → `discord/application.test.ts` ✅
- `src/server/channels/keys.ts` → `keys.test.ts` ✅
- `src/server/channels/core/reply.ts` → `core/reply.test.ts` ✅
- `src/server/log.ts` → `log.test.ts` ✅

---

## Failure Matrix

Error-path scenarios that must be tested to claim complete verification. Each entry describes the failure, how to simulate it, and what the system should do.

### Lifecycle Failures

| Scenario | Simulation | Expected Behavior |
|----------|-----------|-------------------|
| Sandbox create fails | `h.controller` throws on `create()` | Status stays/returns to `error`; no sandbox leak |
| Bootstrap command fails | Responder returns `{ exitCode: 1 }` for install command | Status → `error`; sandbox cleaned up |
| Gateway probe timeout | `ff.onGet(/fake\.vercel\.run/)` returns 503 or never resolves | Status stays `booting`; retry on next access |
| Snapshot fails | `handle.snapshot()` throws | Status → `error`; sandbox still accessible until next attempt |
| Restore fails (bad snapshot) | `h.controller` throws on restore with snapshot ID | Status → `error`; does not corrupt metadata |
| Concurrent `ensureSandboxRunning` | Call twice before first completes | Only one create/restore; second call returns waiting state |
| `after()` callback throws | Schedule callback that throws | Error logged; does not crash route response |

### Channel / Drain Failures

| Scenario | Simulation | Expected Behavior |
|----------|-----------|-------------------|
| Gateway completions API error | `ff.onPost(/completions/)` returns 500 | Job retried; eventually dead-lettered |
| Slack API post failure | `ff.onPost(/slack\.com/)` returns `{ ok: false }` | Reply failure logged; job still completes (message was processed) |
| Telegram API failure | `ff.onPost(/telegram\.org/)` returns 400 | Reply failure logged; job completes |
| Discord follow-up failure | `ff.onPost(/discord\.com/)` returns 500 | Retry or dead-letter |
| Malformed queue job | Enqueue a job with missing `payload` field | Job skipped with error log; queue not blocked |
| Queue processing crash | `ff.otherwise(() => { throw new Error("boom"); })` | Processing lock released; job retried |
| Dead-letter overflow | Exhaust retry count | Job moved to dead-letter queue; processing continues |

### Auth Failures

| Scenario | Simulation | Expected Behavior |
|----------|-----------|-------------------|
| Expired session cookie | `buildSessionCookie({ expiresAt: Date.now() - 1000 })` | 401/redirect to login |
| Invalid session cookie | Garbage cookie value | 401/redirect; no crash |
| Token refresh failure | `ff.onPost(/token/)` returns 401 | Session cleared; user redirected to login |
| Missing CSRF headers | `buildGetRequest` without auth headers on mutating route | 403 |
| Wrong origin in CSRF | Request with `origin: https://evil.com` | 403 |
| No auth on protected route | Plain GET to `/api/admin/ensure` | 401/403 |
| Auth before gateway token | Unauthenticated GET to `/gateway` | Redirect to login; token never exposed |

### Firewall Failures

| Scenario | Simulation | Expected Behavior |
|----------|-----------|-------------------|
| Learning log empty | Responder returns empty string for log file | No domains ingested; no crash |
| Learning log malformed | Responder returns garbage text | Parseable domains extracted; rest ignored |
| Sync without running sandbox | Call `syncFirewall()` when status is `stopped` | No-op; no crash |
| Policy update fails | Handle throws on `updateNetworkPolicy()` | Error logged; firewall state not corrupted |

### Bootstrap Failures

| Scenario | Simulation | Expected Behavior |
|----------|-----------|-------------------|
| `openclaw` install fails | Responder returns `exitCode: 1` for npm install | Status → `error`; clear error message |
| Config write fails | Handle `writeFiles()` throws | Status → `error` |
| Gateway never becomes healthy | Probe always returns 503 | Status stays `booting`; does not loop forever |
| AI Gateway key missing | Env without `AI_GATEWAY_API_KEY` | Bootstrap skips key file; still functional |

### Store Failures

| Scenario | Simulation | Expected Behavior |
|----------|-----------|-------------------|
| Store read returns `null` | Fresh store with no metadata | `ensureMetaShape` creates default metadata |
| Metadata shape outdated | Store contains old-shape metadata | `ensureMetaShape` migrates fields |
| Concurrent metadata mutation | Two `mutateMeta` calls in parallel | Last write wins; no corruption |

### Failure Test Pattern

```typescript
test("[lifecycle] create failure → status becomes error", async () => {
  const h = createScenarioHarness();
  try {
    // Make the controller throw on create
    const origCreate = h.controller.create.bind(h.controller);
    h.controller.create = async () => { throw new Error("API unavailable"); };

    let scheduled: (() => Promise<void>) | null = null;
    await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "test",
      schedule(cb) { scheduled = cb; },
    });
    await scheduled!();

    const meta = await h.getMeta();
    assert.equal(meta.status, "error");
  } finally {
    h.teardown();
  }
});

test("[channels] gateway API 500 → job retried then dead-lettered", async () => {
  const h = createScenarioHarness();
  try {
    // All completions calls fail
    h.fakeFetch.onPost(/v1\/chat\/completions/, () =>
      new Response("Internal Server Error", { status: 500 })
    );
    h.fakeFetch.onPost(/slack\.com/, () => slackOkResponse());

    await h.mutateMeta((m) => { m.status = "running"; m.sandboxId = "sbx-1"; });
    h.configureAllChannels();

    await enqueueChannelJob("slack", {
      payload: slackPayload,
      receivedAt: Date.now(),
      origin: "https://test.example.com",
    });

    // Drain multiple times to exhaust retries
    for (let i = 0; i < 5; i++) await drainSlackQueue();

    const store = h.getStore();
    await assertQueuesDrained(store, "slack", { queue: 0, processing: 0, deadLetter: 1 });
  } finally {
    h.teardown();
  }
});

test("[auth] expired cookie → 401 on protected route", async () => {
  const h = createScenarioHarness({ authMode: "sign-in-with-vercel" });
  try {
    const setCookie = await buildSessionCookie({
      expiresAt: Date.now() - 60_000, // expired 1 minute ago
    });
    const cookie = setCookieToCookieHeader(setCookie);
    const route = getStatusRoute();
    const result = await callRoute(route.GET!, buildGetRequest("/api/status", { cookie }));
    assert.ok(result.status === 401 || result.status === 302);
  } finally {
    h.teardown();
  }
});
```

---

## Run Matrix

Tests can be run under different auth modes and store backends to verify behavior across configurations.

### Auth Mode Variations

| Auth Mode | Env Setup | What It Tests |
|-----------|-----------|---------------|
| `deployment-protection` (default) | `VERCEL_AUTH_MODE=deployment-protection` or unset | Vercel's built-in protection; bypass header `x-vercel-protection-bypass` |
| `sign-in-with-vercel` | `createScenarioHarness({ authMode: 'sign-in-with-vercel' })` | Cookie sessions, JWKS validation, refresh flow |
| `none` | `createScenarioHarness({ authMode: 'none' })` | No auth enforced; useful for channel webhook tests |

### Store Backend Variations

| Backend | Env Setup | When to Use |
|---------|-----------|-------------|
| Memory (default in tests) | No `UPSTASH_REDIS_REST_URL` set | All unit/route/integration tests |
| Upstash | `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` set | Manual smoke testing against real store |

### Running Tests

```bash
# All tests (memory store, deployment-protection auth)
npm test

# All gates via verifier
node scripts/verify.mjs

# Single step via verifier
node scripts/verify.mjs --steps=test
node scripts/verify.mjs --steps=lint
node scripts/verify.mjs --steps=typecheck
node scripts/verify.mjs --steps=build
```

### Per-Auth-Mode Test Strategy

Every route that enforces auth should have tests for:

1. **Happy path with valid credentials** — 200 response
2. **No credentials** — 401 or 302 redirect
3. **Invalid/expired credentials** — 401 or 302
4. **Wrong auth mode credentials** — e.g., cookie sent when `deployment-protection` is active

```typescript
// Template: auth-mode test matrix for a route
for (const mode of ["deployment-protection", "sign-in-with-vercel"] as const) {
  test(`[${mode}] GET /api/status without auth → rejected`, async () => {
    const h = createScenarioHarness({ authMode: mode });
    try {
      const route = getStatusRoute();
      const result = await callRoute(route.GET!, buildGetRequest("/api/status"));
      assert.ok(result.status === 401 || result.status === 302);
    } finally {
      h.teardown();
    }
  });
}
```

---

## Patterns for Adding New Tests

### New Route Test

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { createScenarioHarness } from "@/test-utils/harness";
import {
  patchNextServerAfter,
  callRoute,
  drainAfterCallbacks,
  buildAuthPostRequest,
} from "@/test-utils/route-caller";

patchNextServerAfter();

test("POST /api/my-route returns 200", async () => {
  const h = createScenarioHarness();
  try {
    // Lazy-load route after harness sets up mocks
    const { POST } = await import("@/app/api/my-route/route");

    const request = buildAuthPostRequest("/api/my-route", JSON.stringify({ key: "value" }));
    const result = await callRoute(POST!, request);
    assert.equal(result.status, 200);

    // Run background work (lifecycle, queue, etc.)
    await drainAfterCallbacks();
  } finally {
    h.teardown();
  }
});
```

### New Unit Test (Colocated)

```typescript
// src/server/feature/my-module.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { myFunction } from "@/server/feature/my-module";

test("myFunction handles normal input", () => {
  assert.equal(myFunction("input"), "expected");
});

test("myFunction rejects bad input", () => {
  assert.throws(() => myFunction(""), { message: /required/ });
});
```

### New Channel Adapter Test

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { createScenarioHarness } from "@/test-utils/harness";
import {
  patchNextServerAfter,
  callRoute,
  drainAfterCallbacks,
  getSlackWebhookRoute,
} from "@/test-utils/route-caller";
import { buildSlackWebhook } from "@/test-utils/webhook-builders";
import { gatewayReadyResponse, chatCompletionsResponse, slackOkResponse } from "@/test-utils/fake-fetch";

patchNextServerAfter();

test("Slack webhook enqueues and drains", async () => {
  const h = createScenarioHarness();
  try {
    h.fakeFetch.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());
    h.fakeFetch.onPost(/v1\/chat\/completions/, () => chatCompletionsResponse("Hi!"));
    h.fakeFetch.onPost(/slack\.com\/api/, () => slackOkResponse());

    await h.mutateMeta((m) => { m.status = "running"; m.sandboxId = "sbx-123"; });

    const secrets = h.configureAllChannels();
    const route = getSlackWebhookRoute();
    const webhook = buildSlackWebhook({
      signingSecret: secrets.slackSigningSecret,
      payload: {
        event: { type: "app_mention", text: "hello", channel: "C1", ts: "1.1" },
      },
    });

    const result = await callRoute(route.POST!, webhook);
    assert.equal(result.status, 200);

    await drainAfterCallbacks();
  } finally {
    h.teardown();
  }
});
```

### New Failure Path Test

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { createScenarioHarness } from "@/test-utils/harness";
import { dumpDiagnostics } from "@/test-utils/harness";

test("[lifecycle] bootstrap install failure → error status", async (t) => {
  const h = createScenarioHarness();
  try {
    // Script the sandbox to fail on npm install
    h.controller.onNextCreate((handle) => {
      handle.responders.push((cmd, args) => {
        if (cmd === "bash" && args?.some((a) => a.includes("npm install"))) {
          return { exitCode: 1, output: async () => "ERR! 404 Not Found" };
        }
        return undefined;
      });
    });

    let scheduled: (() => Promise<void>) | null = null;
    await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "test",
      schedule(cb) { scheduled = cb; },
    });
    await scheduled!();

    const meta = await h.getMeta();
    assert.equal(meta.status, "error");
    assert.ok(meta.lastError?.includes("install"));
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    h.teardown();
  }
});
```

### Auth Mode Variation Test

```typescript
import { createScenarioHarness } from "@/test-utils/harness";
import {
  buildSessionCookie,
  setCookieToCookieHeader,
  buildDeploymentProtectionHeaders,
} from "@/test-utils/auth-fixtures";

test("route works with sign-in-with-vercel", async () => {
  const h = createScenarioHarness({ authMode: "sign-in-with-vercel" });
  try {
    const setCookie = await buildSessionCookie();
    const cookie = setCookieToCookieHeader(setCookie);
    const request = buildAuthGetRequest("/api/status", { cookie });
    const result = await callRoute(route.GET!, request);
    assert.equal(result.status, 200);
  } finally {
    h.teardown();
  }
});

test("route works with deployment-protection", async () => {
  const h = createScenarioHarness({ authMode: "deployment-protection" });
  try {
    const headers = buildDeploymentProtectionHeaders();
    const request = buildGetRequest("/api/status", headers);
    const result = await callRoute(route.GET!, request);
    assert.equal(result.status, 200);
  } finally {
    h.teardown();
  }
});
```

### New Smoke Test Scenario

To add a new scenario to the full smoke test:

```typescript
// In src/server/smoke/full-smoke.test.ts, inside the main test:

await t.test("Phase N: my new scenario", async () => {
  // Previous phases' state is available via h
  const meta = await h.getMeta();

  // Set up mocks specific to this scenario
  h.fakeFetch.onPost(/my-pattern/, () => Response.json({ ok: true }));

  // Exercise the subsystem
  const result = await myFunction();

  // Assert outcomes
  assert.equal(result.status, "expected");

  // Assert no regressions
  assertNoBrowserAuthTraffic(h.fakeFetch.requests());

  h.log.info("phase-N-complete");
});
```

---

## Definition of Done

A test suite achieves "complete verification" when all four categories are satisfied. Use this checklist when adding tests or auditing coverage.

### Happy-Path Coverage

- [ ] Every API route has at least one test that exercises the success path with valid auth
- [ ] Every server module with logic (not just types/constants) has a corresponding test file
- [ ] Full smoke test passes all phases without modifications
- [ ] All channel platforms (Slack, Telegram, Discord) have webhook → enqueue → drain → reply tests
- [ ] Lifecycle state machine covers all valid transitions: `uninitialized → creating → setup → booting → running → stopped → restoring → running`
- [ ] Firewall covers all modes: `disabled`, `learning`, `enforcing`
- [ ] Proxy HTML injection verified: script tag, WS rewrite, base tag, token in script only

### Error-Path Coverage

- [ ] Lifecycle failures tested: create fail, bootstrap fail, probe timeout, snapshot fail, restore fail
- [ ] Channel failures tested: gateway API error, platform API error, malformed job, retry exhaustion, dead-letter
- [ ] Auth failures tested: expired cookie, invalid cookie, missing credentials, refresh failure
- [ ] Firewall failures tested: empty/malformed learning log, sync without sandbox, policy update failure
- [ ] Bootstrap failures tested: install fail, config write fail, gateway never healthy
- [ ] Store failures tested: null metadata, outdated shape migration, concurrent mutation

### Auth Boundary Coverage

- [ ] Every protected route rejects unauthenticated requests (401/302)
- [ ] Every protected route accepts valid `deployment-protection` credentials
- [ ] Every protected route accepts valid `sign-in-with-vercel` session cookies
- [ ] Gateway route never exposes gateway token without auth
- [ ] CSRF validation tested: missing headers → 403, wrong origin → 403
- [ ] Auth refresh failure clears session and forces re-login

### Regression Guards

- [ ] No `export const runtime` in any route handler
- [ ] `patchNextServerAfter()` called before route imports in all route tests
- [ ] `drainAfterCallbacks()` called after every route invocation
- [ ] `try/finally` teardown in every test using a harness
- [ ] `dumpDiagnostics(t, h)` in catch blocks for integration/scenario tests
- [ ] Smoke test invariants verified: queue drain, lifecycle sequence, timestamp monotonicity, error log absence

### Gate Commands

All four gates must pass before work is considered complete:

```bash
npm run lint        # Gate 1: formatting + imports
npm test        # Gate 2: all tests pass
npm run typecheck   # Gate 3: no type errors
npm build       # Gate 4: production build succeeds
```

---

## Testing Principles

1. **Isolation** — Each test gets a fresh harness with reset singletons, env, and store
2. **No real network** — All HTTP intercepted via `FakeFetch`; no actual API calls
3. **No sandbox API** — `FakeSandboxController` mocks `@vercel/sandbox` entirely
4. **Deterministic** — Fake delays, ordered event logs, predictable responses
5. **Async aware** — `after()` callbacks captured and drained explicitly
6. **Auth configurable** — Tests can run in any auth mode
7. **Always teardown** — Use `try/finally` with `h.teardown()` or `withHarness`
8. **Observability on failure** — Use `dumpDiagnostics(t, h)` in catch blocks
9. **Test naming** — Use `[area] precondition → action → expected` pattern
10. **Smoke test accumulates** — Single harness across phases; state builds naturally
11. **Failure paths are first-class** — Error scenarios deserve dedicated tests, not just happy-path assertions
12. **Auth boundaries are security boundaries** — Every protected route must be tested without credentials

---

## Complete Verification Protocol

Before marking any work complete, pass ALL gates in order:

```bash
# Gate 1: Lint — catches formatting and import issues
npm run lint

# Gate 2: Tests — all tests pass (including smoke)
npm test

# Gate 3: Type check — no type errors
npm run typecheck

# Gate 4: Build — production build succeeds
npm build
```

### Verification Checklist

- [ ] All existing tests still pass (no regressions)
- [ ] Smoke test passes all 8 phases
- [ ] No `export const runtime` added to route handlers
- [ ] `try/finally` teardown in all new tests
- [ ] `patchNextServerAfter()` called before route imports
- [ ] `drainAfterCallbacks()` called after route invocations
- [ ] New env vars documented in `.env.example` and `CLAUDE.md`
- [ ] Metadata shape changes reflected in `ensureMetaShape`
- [ ] Definition of Done checklist satisfied for the category of work

---

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `@vercel/sandbox` | Sandbox VM lifecycle (create, stop, snapshot, restore) |
| `@upstash/redis` | Persistent state store |
| `@vercel/oidc` | Vercel OAuth token exchange |
| `jose` | JWT signing/verification for session cookies |
| `next` 16 | App Router framework |

## Test Utilities File Index

| File | Lines | Purpose |
|------|-------|---------|
| `src/test-utils/harness.ts` | 565 | Central scaffold: controller, fetch, store, log, scenario helpers, observability |
| `src/test-utils/fake-fetch.ts` | 225 | HTTP interception + preset responses |
| `src/test-utils/fake-sandbox-controller.ts` | 222 | Complete `@vercel/sandbox` mock |
| `src/test-utils/route-caller.ts` | 486 | Route invocation + patching + request builders + lazy loaders |
| `src/test-utils/webhook-builders.ts` | 213 | Signed webhook requests (Slack, Telegram, Discord) |
| `src/test-utils/auth-fixtures.ts` | 117 | Session cookies + deployment protection headers |
| `src/test-utils/assertions.ts` | 175 | Reusable assertion helpers (gateway, queues, history, auth) |

## Critical Gotchas

- **`patchNextServerAfter()`** must be called at module top level, before any route imports
- **`drainAfterCallbacks()`** is required after route calls to execute `after()` background work
- **Teardown is mandatory** — leaking harness state corrupts subsequent tests
- **Lazy route loading** — always use `getXxxRoute()` helpers or dynamic `import()` after harness setup
- **`snapshot()` is DESTRUCTIVE** — calling snapshot stops the sandbox; never use as diagnostic
- **Store defaults to memory** — without `UPSTASH_REDIS_REST_URL`, data is lost on redeploy
- **No `export const runtime`** — explicit runtime exports break the Next.js 16 build with `cacheComponents: true`
- **`globalThis.fetch` swap** — when tests need fetch interception, save/restore in try/finally
- **Command responders** — return `undefined` to fall through to default behavior; first non-undefined wins
- **Smoke test is sequential** — phases depend on each other; don't reorder without understanding the state flow
- **`npm test` is the canonical runner** — never use `bun test` (different resolver, different globals, will produce false failures)

---

## Smoke Test Tiers

Testing is organized into three smoke tiers, each building on the previous:

### Tier 1: Happy-Path Smoke (`full-smoke.test.ts`)

The existing 8-phase end-to-end lifecycle test. Exercises:
- Fresh create + bootstrap → running
- Proxy HTML injection + WebSocket rewrite + no token leak
- Firewall learning → enforce → policy applied
- Snapshot stop → restore via channel trigger
- Multi-channel replies (Slack, Telegram, Discord)
- Final invariants (clean queues, correct lifecycle sequence)

**When to run:** After any change to lifecycle, proxy, firewall, or channel modules.

### Tier 2: Failure & Concurrency Smoke (`concurrency-smoke.test.ts`)

Tests edge cases the happy path misses:
- Simultaneous restore attempts (only one sandbox created)
- Stop during active drain (clean shutdown, no orphan processing items)
- Double-snapshot (idempotent)
- Crash recovery (expired leases requeued, drain lock released)
- Auth session expiry during active proxy session

**When to run:** After changes to state transitions, queue processing, or lock management.

### Tier 3: Route-Level Smoke (`route-smoke.test.ts`)

Tests the actual Next.js route handlers end-to-end through the route-caller utilities:
- Admin routes: ensure, stop, snapshot, ssh, logs, snapshots-list, restore
- Firewall routes: GET/PUT/POST/DELETE with test and allowlist management
- Channel webhooks: Slack, Telegram, Discord (signature verification)
- Auth routes: authorize, callback, signout
- Gateway proxy: auth gating, waiting page, HTML injection
- Status/health: GET/POST status, GET health
- Cron: drain-channels with CRON_SECRET
- Auth enforcement: 401/403 for unauthenticated requests
- CSRF checks: missing origin/x-requested-with on mutations

**When to run:** After changes to any route handler or auth middleware.

---

## fakeFetch Request-Object Fix

The `fakeFetch` utility in `src/test-utils/fake-fetch.ts` handles both calling conventions:

1. `fetch(url: string, init?: RequestInit)` — the simple form
2. `fetch(request: Request, init?: RequestInit)` — the Request-object form

**When it matters:** Route handlers and auth code that construct `new Request(url, { method, headers, body })` and pass the whole object to `fetch()`. Without this fix, the fake would fail to extract method, headers, and body from Request objects, causing false-green tests where the request content is silently lost.

The fix checks `typeof input !== "string"` and reads `.method`, `.headers`, `.body` from the Request object when `init` doesn't provide them. The `init` parameter always takes precedence (merge behavior).

Tests for this live in `src/test-utils/harness-isolation.test.ts` under the `fakeFetch:` prefix.

---

## Coverage Manifest

Every source file mapped to its test file(s). Files marked with ✅ have direct unit tests. Files marked with 🔥 are covered indirectly through smoke or integration tests.

### `src/server/sandbox/`
| Source | Test | Coverage |
|--------|------|----------|
| `controller.ts` | `controller.test.ts` | ✅ Interface shape, swap mechanism, event logging |
| `lifecycle.ts` | `lifecycle.test.ts` | ✅ State transitions, ensure/stop/snapshot/touch |
| `lifecycle.ts` | `route-scenarios.test.ts`, `scenarios.test.ts` | 🔥 Multi-step scenario flows |

### `src/server/firewall/`
| Source | Test | Coverage |
|--------|------|----------|
| `policy.ts` | `policy.test.ts` | ✅ toNetworkPolicy all modes, applyFirewallPolicyToSandbox |
| `state.ts` | `state.test.ts` | ✅ Mode transitions, learning ingestion, domain extraction |
| `domains.ts` | `domains.test.ts` | ✅ Domain parsing and normalization |
| `state.ts` | `firewall-sync.test.ts` | ✅ Sync mutations after state changes |

### `src/server/channels/`
| Source | Test | Coverage |
|--------|------|----------|
| `driver.ts` | `driver.test.ts` | ✅ Enqueue, drain, retry, dedup, dead letter |
| `keys.ts` | `keys.test.ts` | ✅ All key generators, uniqueness |
| `state.ts` | `state.test.ts` | ✅ Channel config CRUD |
| `core/reply.ts` | `core/reply.test.ts` | ✅ extractReply, toPlainText, image extraction |
| `history.ts` | `history.test.ts` | ✅ Session history persistence |
| `slack/adapter.ts` | `slack/adapter.test.ts` | ✅ Message extraction, reply formatting |
| `slack/route.ts` | `slack/route.test.ts` | ✅ Webhook validation, enqueue |
| `telegram/adapter.ts` | `telegram/adapter.test.ts` | ✅ Message extraction, reply |
| `telegram/bot-api.ts` | `telegram/bot-api.test.ts` | ✅ Bot API calls |
| `telegram/route.ts` | `telegram/route.test.ts` | ✅ Webhook secret validation |
| `discord/adapter.ts` | `discord/adapter.test.ts` | ✅ Interaction handling |
| `discord/discord-api.ts` | `discord/discord-api.test.ts` | ✅ Discord REST calls |
| `discord/route.ts` | `discord/route.test.ts` | ✅ Ed25519 signature verification |
| `discord/application.ts` | `discord/application.test.ts` | ✅ Application setup, command registration |
| `slack/runtime.ts` | `slack/runtime.test.ts` | ✅ Slack runtime behavior |
| `telegram/runtime.ts` | `telegram/runtime.test.ts` | ✅ Telegram runtime behavior |
| `discord/runtime.ts` | `discord/runtime.test.ts` | ✅ Discord runtime behavior |
| `drain.ts` (shared drain) | `drain.test.ts` | ✅ Generic drain logic |
| `drain.ts` | `drain-lifecycle.test.ts` | ✅ Drain triggers sandbox restore |
| `drain.ts` | `drain-retry.test.ts` | ✅ Retry backoff and dead letter |
| `drain.ts` | `drain-auth-decay.test.ts` | ✅ Auth decay during drain |

### `src/server/auth/`
| Source | Test | Coverage |
|--------|------|----------|
| `vercel-auth.ts` | `vercel-auth.test.ts` | ✅ OAuth flow, token exchange, session building |
| `vercel-auth.ts` | `route-auth.test.ts` | ✅ requireRouteAuth both modes, sanitizeNextPath |
| `session.ts` | `session.test.ts` | ✅ Cookie encryption/decryption, serialization |
| `csrf.ts` | `csrf.test.ts` | ✅ CSRF token validation |

### `src/server/store/`
| Source | Test | Coverage |
|--------|------|----------|
| `store.ts` | `store.test.ts` | ✅ Store selection, singleton, mutateMeta CAS |
| `memory-store.ts` | `memory-store.test.ts` | ✅ Full contract: meta, KV, queues, leases, locks |
| `upstash-store.ts` | — | 🔥 Same interface as memory-store; integration-tested via store.test.ts |

### `src/server/proxy/`
| Source | Test | Coverage |
|--------|------|----------|
| `htmlInjection.ts` | `htmlInjection.test.ts` | ✅ Script injection, WS rewrite |
| `waitingPage.ts` | `waitingPage.test.ts` | ✅ Waiting page HTML generation |
| `proxy-route-utils.ts` | `proxy-route-utils.test.ts` | ✅ Proxy request building |

### `src/server/openclaw/`
| Source | Test | Coverage |
|--------|------|----------|
| `bootstrap.ts` | `bootstrap.test.ts` | ✅ Install, config write, gateway wait |
| `config.ts` | `config.test.ts` | ✅ Config generation |

### `src/server/`
| Source | Test | Coverage |
|--------|------|----------|
| `env.ts` | `env.test.ts` | ✅ Env getters, auth mode selection |
| `log.ts` | `log.test.ts` | ✅ Structured logger contract, id/source fields |

### `src/app/api/` (Route Handlers)
| Source | Test | Coverage |
|--------|------|----------|
| `admin/` routes | `admin-lifecycle.test.ts`, `admin-firewall-routes.test.ts` | ✅ |
| `admin/ensure/` | `admin/ensure/route.test.ts` | ✅ |
| `admin/logs/` | `admin/logs/route.test.ts` | ✅ |
| `admin/snapshot/` | `admin/snapshot/route.test.ts` | ✅ |
| `admin/snapshots/` | `admin/snapshots/route.test.ts` | ✅ |
| `admin/snapshots/restore/` | `admin/snapshots/restore/route.test.ts` | ✅ |
| `admin/ssh/` | `admin/ssh/route.test.ts` | ✅ |
| `admin/stop/` | `admin/stop/route.test.ts` | ✅ |
| `auth/` routes | `auth/auth-routes.test.ts`, `auth/auth-enforcement.test.ts` | ✅ |
| `channels/summary/` | `channels/summary/route.test.ts` | ✅ |
| `channels/slack/webhook/` | `channels/slack/webhook/route.test.ts` | ✅ |
| `channels/slack/manifest/` | `channels/slack/manifest/route.test.ts` | ✅ |
| `channels/slack/test/` | `channels/slack/test/route.test.ts` | ✅ |
| `channels/telegram/webhook/` | `channels/telegram/webhook/route.test.ts` | ✅ |
| `channels/telegram/preview/` | `channels/telegram/preview/route.test.ts` | ✅ |
| `channels/discord/webhook/` | `channels/discord/webhook/route.test.ts` | ✅ |
| `channels/discord/register-command/` | `channels/discord/register-command/route.test.ts` | ✅ |
| `cron/drain-channels/` | `cron/drain-channels/route.test.ts` | ✅ |
| `firewall/` | `firewall/route.test.ts` | ✅ |
| `firewall/allowlist/` | `firewall/allowlist/route.test.ts` | ✅ |
| `firewall/promote/` | `firewall/promote/route.test.ts` | ✅ |
| `firewall/test/` | `firewall/test/route.test.ts` | ✅ |
| `health/` | `health/route.test.ts` | ✅ |
| `status/` | `status/route.test.ts` | ✅ |
| `gateway/` | `gateway/route.test.ts` | ✅ |

### `src/server/smoke/` (Meta-tests)
| Source | Test | Coverage |
|--------|------|----------|
| `full-smoke.test.ts` | (self) | ✅ Tier 1: happy-path lifecycle |
| `route-smoke.test.ts` | (self) | ✅ Tier 3: route-level E2E |
| `concurrency-smoke.test.ts` | (self) | ✅ Tier 2: failure & concurrency |

### `src/test-utils/`
| Source | Test | Coverage |
|--------|------|----------|
| `harness.ts` | `harness-isolation.test.ts` | ✅ Isolation, teardown, env restore |
| `fake-fetch.ts` | `harness-isolation.test.ts` | ✅ Request-object fix, reset behavior |
| `fake-sandbox-controller.ts` | `controller.test.ts` | ✅ Interface conformance |
| `route-caller.ts` | — | 🔥 Exercised by every route test |
| `webhook-builders.ts` | — | 🔥 Exercised by channel route tests |
| `auth-fixtures.ts` | — | 🔥 Exercised by auth + admin tests |
| `assertions.ts` | — | 🔥 Exercised by smoke tests |

---

## Verification Protocol (Updated)

Always use `npm test` — never `bun test`. The canonical verification sequence:

```bash
npm test          # 854 tests across all tiers
npm run typecheck     # tsc --noEmit
npm run lint          # eslint (1 pre-existing React warning-as-error)
npm build         # Next.js production build
```

All four must pass before work is considered done. The lint error about `setState` in `admin-shell.tsx` is pre-existing and unrelated to test coverage.
