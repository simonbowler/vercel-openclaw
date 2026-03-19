# Restore Flow Architecture

## Phase Dependencies

```
resolveAiGatewayCredentialOptional()     ← OIDC fetch (~0s if cached)
        │
        ▼
Sandbox.create({ env: tokens, source: snapshot })  ← 1.4s platform
        │
        ├─── mutateMeta (sandboxId, portUrls)
        │
        ▼
Promise.all([
  credentialWritePromise,                ← Non-blocking file persistence
  syncRestoreAssetsIfNeeded(),           ← 5.7s (writeFiles for openclaw.json)
  ─── then ───
  Promise.all([
    fast-restore-script (bash),          ← 7.9s (gateway boot + readiness)
    applyFirewallPolicyToSandbox(),      ← 0.1s (concurrent)
  ]),
])
        │
        ▼
mutateMeta(status: "running")
        │
        ▼
Optional: waitForPublicGatewayReady()    ← 0-5s (skipped for background)
```

## Key Files

| File | Responsibility |
|------|---------------|
| `src/server/sandbox/lifecycle.ts` | `restoreSandboxFromSnapshot()` — orchestrates all phases |
| `src/server/openclaw/config.ts` | `buildFastRestoreScript()` — bash script with readiness loop |
| `src/server/openclaw/bootstrap.ts` | `setupOpenClaw()` — cold create path (installs openclaw + Bun) |
| `src/server/openclaw/restore-assets.ts` | Static/dynamic asset split, manifest-based skip |
| `src/server/sandbox/controller.ts` | `SandboxHandle` interface wrapping `@vercel/sandbox` |
| `src/server/sandbox/resources.ts` | `getSandboxVcpus()` — vCPU configuration |
| `src/server/sandbox/timeout.ts` | Sleep-after and touch-throttle configuration |

## Fast-Restore Script Behavior

The script (`buildFastRestoreScript()`) runs as a single `sandbox.runCommand("bash", [...])`:

1. Read gateway token from env (OPENCLAW_GATEWAY_TOKEN) or file
2. Read AI key from env (AI_GATEWAY_API_KEY) or file
3. Delete Telegram webhook if configured
4. `pkill -f "openclaw.gateway"` (kill stale process from snapshot)
5. `setsid bun openclaw gateway ...` (or node fallback)
6. Curl loop: poll localhost:3000 every 100ms until `openclaw-app` marker
7. Force-pair device identity (after readiness, non-blocking for page load)
8. Print JSON to stdout: `{"ready":true,"attempts":N,"readyMs":M}`

## Sandbox API Cost Model

Each SDK call has ~2-9s of platform overhead regardless of payload size:

- `Sandbox.create()` — 1.4s (from snapshot)
- `sandbox.writeFiles()` — 5-9s (single call, any number of files)
- `sandbox.runCommand()` — 2-5s per call
- `sandbox.readFileToBuffer()` — 2-3s per call

**Optimization principle**: minimize the NUMBER of SDK calls, not the data size. Batch file writes into single `writeFiles()` calls. Move logic inside bash scripts to avoid multiple `runCommand()` calls.

## Credential Flow

Tokens are passed at sandbox create time via `env` parameter:
```typescript
Sandbox.create({
  env: {
    OPENCLAW_GATEWAY_TOKEN: gatewayToken,
    AI_GATEWAY_API_KEY: freshApiKey,
    OPENAI_API_KEY: freshApiKey,
    OPENAI_BASE_URL: "https://ai-gateway.vercel.sh/v1",
  },
  source: { type: "snapshot", snapshotId },
})
```

The fast-restore script reads from env first, falling back to files. File writes happen concurrently with boot for persistence (token refresh needs files on disk).
