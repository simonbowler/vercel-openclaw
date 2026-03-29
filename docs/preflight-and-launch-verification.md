# Preflight and Launch Verification

## What preflight proves

Preflight is a config-readiness check. It runs without touching the sandbox and answers questions like:

- Can the app resolve a canonical public origin?
- Is the durable store (Upstash) configured?
- Is AI Gateway auth available (OIDC or API key)?
- Is auth configuration complete?
- Is cron authentication configured?
- Are channel prerequisites met (webhook URLs resolvable, store available)?

Preflight is a config-readiness check. It does not prove the sandbox can complete a real channel delivery. It only proves the deployment is configured correctly.

## What launch verification proves

Launch verification is the runtime check. It starts with preflight, then verifies the system can actually do the work it claims to do: deliver a queue message, start the sandbox, get a real chat completion from the gateway, stop the sandbox, wake it back up, and seal a reusable restore target.

## Safe mode vs destructive mode

### Safe mode

Safe mode runs preflight and queue delivery checks only. It does not start, stop, or wake the sandbox.

### Destructive mode

Destructive mode proves the full operational path: start the sandbox, run a real completion, stop it, wake it from sleep, and prepare a fresh restore target. This is the mode that sets `channelReadiness.ready = true`.

## Launch verification phases

| Phase | What it proves |
| ----- | -------------- |
| `preflight` | Config readiness — all deployment requirements are met |
| `queuePing` | Queue delivery loopback works (Vercel Queues can reach the app) |
| `ensureRunning` | The sandbox can start from scratch or restore and become ready |
| `chatCompletions` | The gateway can answer a real completions request |
| `wakeFromSleep` | The stop-and-wake path works (snapshot, stop, restore) |
| `restorePrepared` | A fresh reusable restore target is sealed and verified |

## Fields to inspect on failure

When launch verification reports `ok: false`, these fields explain why:

- `diagnostics.failingCheckIds` — which preflight checks failed
- `diagnostics.requiredActionIds` — which operator actions are blocking
- `diagnostics.failingChannelIds` — which channels have unresolved prerequisites
- `runtime.dynamicConfigVerified` — whether the running sandbox config matches the desired state
- `runtime.dynamicConfigReason` — `hash-match`, `hash-miss`, or `no-snapshot-hash`
- `sandboxHealth.configReconciled` — whether stale config was successfully fixed
- `sandboxHealth.configReconcileReason` — what happened during reconciliation
- `runtime.restorePreparedStatus` — whether the restore target is reusable
- `runtime.restorePreparedReason` — why the restore target is in its current state

## Important nuances

**`ok: true` means more than "the sandbox booted once."** The payload can still be unhealthy when:

- Dynamic config has drifted since the last restore (`dynamicConfigVerified: false`)
- The restore target is not reusable (`restorePreparedStatus` is not `ready`)
- Config reconciliation failed after an otherwise successful boot

**`ok: false` is authoritative.** Even when individual phases look healthy, treat `ok: false` as a real problem. Stale dynamic config that could not be reconciled is a hard failure.

## Channel readiness

`channelReadiness` is a persisted summary of the current deployment's launch verification result. It is separate from preflight channel checks.

- **Preflight channel checks** tell you whether a channel *can* be connected (webhook URL resolvable, store available, AI Gateway auth present).
- **Channel readiness** tells you whether the full pipeline *has been verified* for this deployment (sandbox boots, completions work, wake-from-sleep works).

`channelReadiness.ready` is only `true` after destructive launch verification passes every phase for the current deployment. A deployment is channel-ready only after destructive launch verification passes and `channelReadiness.ready` is `true`.

Run destructive launch verification before connecting Slack or Telegram.

## Example launch verification result

```json
{
  "ok": true,
  "mode": "destructive",
  "phases": [
    { "id": "preflight", "status": "pass" },
    { "id": "queuePing", "status": "pass" },
    { "id": "ensureRunning", "status": "pass" },
    { "id": "chatCompletions", "status": "pass" },
    { "id": "wakeFromSleep", "status": "pass" },
    { "id": "restorePrepared", "status": "pass" }
  ],
  "runtime": {
    "dynamicConfigVerified": true,
    "dynamicConfigReason": "hash-match",
    "restorePreparedStatus": "ready",
    "restorePreparedReason": "prepared"
  }
}
```

## Where to read next

- [Channels and Webhooks](channels-and-webhooks.md) — how to connect Slack and Telegram after verification passes
- [API Reference](api-reference.md) — full request and response shapes for preflight and launch verification
- [Sandbox Lifecycle and Restore](lifecycle-and-restore.md) — the lifecycle states and restore mechanics that launch verification exercises
