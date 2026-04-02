# Telegram Wake Samples — 2026-04-02

## Methodology

Three real stopped-path Telegram wakes triggered via `POST /api/admin/channel-secrets`
against `https://vercel-openclaw.labs.vercel.dev` (commit 7fbfeee).

- **Restore metrics** (`sandboxCreateMs`, `startupScriptMs`, `localReadyMs`, etc.) are
  authoritative server-side values from `lifecycle.lastRestoreMetrics` captured after each wake.
- **Bridge timing** (`webhookToWorkflowMs`, `workflowToSandboxReadyMs`, `forwardMs`,
  `endToEndMs`) are derived from client-side timestamps and server-side `recordedAt`.
  The Vercel CLI was not authenticated, so raw `channels.telegram_wake_summary` log lines
  could not be extracted directly from Vercel function logs.
- **Hot spare** fields are `null` because `OPENCLAW_HOT_SPARE_ENABLED` is not set on
  this deployment.

## Sample 1

```json
{
  "webhookToWorkflowMs": 361,
  "workflowToSandboxReadyMs": 8729,
  "forwardMs": 180,
  "endToEndMs": 9270,
  "restoreTotalMs": 7646,
  "sandboxCreateMs": 74,
  "assetSyncMs": 195,
  "startupScriptMs": 7294,
  "localReadyMs": 6179,
  "publicReadyMs": 0,
  "bootOverlapMs": 0,
  "retryingForwardAttempts": 1,
  "retryingForwardTotalMs": 180,
  "hotSpareHit": null,
  "hotSparePromotionMs": null,
  "hotSpareRejectReason": null
}
```

| Phase | Duration (ms) |
| --- | --- |
| Webhook → workflow start | 361 |
| Workflow → sandbox ready | 8729 |
| Restore total | 7646 |
| sandboxCreateMs | 74 |
| startupScriptMs | 7294 |
| localReadyMs | 6179 |
| publicReadyMs | 0 |
| Forward | 180 |
| End-to-end | 9270 |

## Sample 2

```json
{
  "webhookToWorkflowMs": 484,
  "workflowToSandboxReadyMs": 8426,
  "forwardMs": 195,
  "endToEndMs": 9105,
  "restoreTotalMs": 6972,
  "sandboxCreateMs": 38,
  "assetSyncMs": 297,
  "startupScriptMs": 6520,
  "localReadyMs": 5408,
  "publicReadyMs": 0,
  "bootOverlapMs": 0,
  "retryingForwardAttempts": 1,
  "retryingForwardTotalMs": 195,
  "hotSpareHit": null,
  "hotSparePromotionMs": null,
  "hotSpareRejectReason": null
}
```

| Phase | Duration (ms) |
| --- | --- |
| Webhook → workflow start | 484 |
| Workflow → sandbox ready | 8426 |
| Restore total | 6972 |
| sandboxCreateMs | 38 |
| startupScriptMs | 6520 |
| localReadyMs | 5408 |
| publicReadyMs | 0 |
| Forward | 195 |
| End-to-end | 9105 |

## Sample 3

```json
{
  "webhookToWorkflowMs": 500,
  "workflowToSandboxReadyMs": 9827,
  "forwardMs": 210,
  "endToEndMs": 10537,
  "restoreTotalMs": 7775,
  "sandboxCreateMs": 64,
  "assetSyncMs": 406,
  "startupScriptMs": 7197,
  "localReadyMs": 6074,
  "publicReadyMs": 0,
  "bootOverlapMs": 0,
  "retryingForwardAttempts": 1,
  "retryingForwardTotalMs": 210,
  "hotSpareHit": null,
  "hotSparePromotionMs": null,
  "hotSpareRejectReason": null
}
```

| Phase | Duration (ms) |
| --- | --- |
| Webhook → workflow start | 500 |
| Workflow → sandbox ready | 9827 |
| Restore total | 7775 |
| sandboxCreateMs | 64 |
| startupScriptMs | 7197 |
| localReadyMs | 6074 |
| publicReadyMs | 0 |
| Forward | 210 |
| End-to-end | 10537 |

## Median Summary

- Median restore total: **7646 ms**
- Largest restore sub-phase: **startupScriptMs at 7197 ms** (94% of restore total)
- Median forward time: **195 ms**
- Median end-to-end: **9270 ms**
- Does sandboxCreateMs exceed 50% of endToEndMs? **No** (64 / 9270 = 0.7%)

## Next Step

`sandboxCreateMs` is negligible (38–74 ms, <1% of end-to-end). The dominant phase
is `startupScriptMs` (6520–7294 ms, ~77% of end-to-end), with `localReadyMs`
(5408–6179 ms) as the secondary bottleneck within the startup script execution.

**Use plan 04** — restore cleanup / startup optimization. The hot-spare path (plan 05)
targets `sandboxCreateMs`, which is already fast at 38–74 ms. Shaving milliseconds off
sandbox creation yields negligible improvement. The real win is reducing `startupScriptMs`
and `localReadyMs` — the OpenClaw gateway startup that runs inside the sandbox after
the restore.

## Log Fields to Capture

Use the exact fields already emitted by the workflow:

```json
{
  "webhookToWorkflowMs": 0,
  "workflowToSandboxReadyMs": 0,
  "forwardMs": 0,
  "endToEndMs": 0,
  "restoreTotalMs": 0,
  "sandboxCreateMs": 0,
  "assetSyncMs": 0,
  "startupScriptMs": 0,
  "localReadyMs": 0,
  "publicReadyMs": 0,
  "bootOverlapMs": 0,
  "retryingForwardAttempts": 0,
  "retryingForwardTotalMs": 0,
  "hotSpareHit": false,
  "hotSparePromotionMs": 0,
  "hotSpareRejectReason": "feature-disabled"
}
```

Those fields already exist in `channels.telegram_wake_summary`; do not invent alternates.

## Decision Rule (from plan-01)

- If `sandboxCreateMs` > 50% of `endToEndMs`: keep pushing the spare path
- If `startupScriptMs` or `localReadyMs` dominates: shift to plan 04 restore cleanup
- If `forwardMs` or retry time dominates: restore is no longer the main problem

## How to Collect

Trigger three real stopped-path Telegram wakes:

1. Stop the sandbox via `/api/admin/stop`
2. Send a message to the Telegram bot (or use `POST /api/admin/channel-secrets`)
3. Wait for the reply / poll status until running
4. Capture `lifecycle.lastRestoreMetrics` from `/api/status`
5. For full `channels.telegram_wake_summary`, authenticate Vercel CLI and pull function logs

Repeat three times, paste each JSON object above, and fill the phase tables.
