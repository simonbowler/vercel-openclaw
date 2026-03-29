# Channels and Webhooks

## What this doc covers

This guide explains how to connect Slack and Telegram to your OpenClaw deployment. It covers what needs to be true before you connect a channel, how readiness is determined, how each platform behaves differently, and what to do when things go wrong.

Channels are a first-class part of the product. They depend on durable state (Upstash Redis), a working sandbox lifecycle, and a verified deployment. This guide walks through the full path from "deployment exists" to "channel is safely connected and working."

## Before you connect a channel

Run destructive launch verification before connecting Slack or Telegram. This is the step that proves the sandbox can boot, answer completions, stop, and wake back up — the full path that channel delivery depends on.

Before connecting, your deployment needs:

- **A resolvable public HTTPS origin.** The app must be able to build a canonical webhook URL. If it cannot, channel connect is blocked.
- **AI Gateway auth available.** On Vercel deployments, this means OIDC. If AI Gateway auth is `unavailable`, channel connect is blocked.
- **Upstash Redis configured.** Channels rely on durable state for webhook queues and session history. On Vercel deployments, missing Upstash is a hard blocker. In local/non-Vercel environments it is a warning only.
- **Destructive launch verification passed.** Destructive launch verification is the step that proves the full channel pipeline, not just the deployment config.

If any hard blocker is present, the channel config route returns HTTP 409 with a `CHANNEL_CONNECT_BLOCKED` error and a machine-readable list of issues.

## Preflight vs channel readiness

These are two different questions, and the difference matters.

Preflight tells you whether a channel can be connected. Channel readiness tells you whether the deployment has already proven the real delivery path.

**Preflight** is a config-readiness check. It runs without touching the sandbox. It answers: "Is the webhook URL resolvable? Is the store configured? Is AI Gateway auth present?" Preflight is a config-readiness check. It does not prove the sandbox can complete a real channel delivery.

**Channel readiness** is a persisted result that records whether the current deployment has passed the full destructive launch verification path — sandbox boot, chat completions, wake from sleep, and restore-target sealing. A deployment is channel-ready only after destructive launch verification passes and `channelReadiness.ready` is `true`.

Operators should run destructive launch verification before treating a deployment as channel-ready. Safe-mode verification only checks config and queue delivery; it does not exercise the sandbox lifecycle that channels depend on.

## Slack

### Connecting Slack

Configure Slack credentials from the admin panel. The app stores the credentials in the metadata record and builds a webhook URL pointing to `/api/channels/slack/webhook`.

Slack delivery URLs may include the protection bypass parameter (`x-vercel-protection-bypass`) when `VERCEL_AUTOMATION_BYPASS_SECRET` is configured. This lets Slack webhooks reach the app even on protected deployments.

### How Slack messages flow

When a Slack message arrives at the webhook:

1. The route validates the Slack signature.
2. If the sandbox is running, the message is forwarded directly to the OpenClaw gateway's `/slack/events` endpoint on port 3000 inside the sandbox (the fast path).
3. If the sandbox is stopped, the route starts a durable Workflow that restores the sandbox, sends the message to the gateway via `POST /v1/chat/completions`, and delivers the reply back to Slack.
4. Slack uses threaded replies for responses.

## Telegram

### Connecting Telegram

Configure Telegram credentials from the admin panel. The app stores the bot token and webhook secret, then registers the webhook URL with the Telegram Bot API via `setWebhook`.

OpenClaw's config includes the app's public Telegram webhook route as `webhookUrl`. When the sandbox boots, OpenClaw itself also calls `setWebhook` with this URL, so the app's endpoint — not the sandbox's — is what Telegram calls.

Telegram registration URLs must not include the bypass query parameter. Telegram validates webhooks via the `x-telegram-bot-api-secret-token` header, and including the bypass parameter can cause `setWebhook` to silently drop registration.

### How Telegram messages flow

When a Telegram update arrives at the webhook:

1. The route validates the webhook secret header.
2. If the sandbox is running, the raw update is forwarded to OpenClaw's native Telegram handler on port 8787 inside the sandbox (the fast path). This preserves full native Telegram features — slash commands, media, inline keyboards, etc.
3. If the sandbox is stopped, the route sends a boot message ("Starting up…") to the user, then starts a durable Workflow that restores the sandbox, sends the message via chat completions, delivers the reply, and deletes the boot message.

## Protected deployments

Slack can use a bypass-capable delivery URL on protected deployments. Telegram intentionally cannot.

This is because Telegram's `setWebhook` registration silently fails when extra query parameters are present in the URL. To make Telegram work on a protected deployment, configure a Deployment Protection Exception or use another protection-compatible path.

Admin-visible URLs — in the admin panel, preflight payload, status responses, and docs examples — must stay display-safe and never expose the bypass secret. The app enforces this by using `buildPublicDisplayUrl()` for all operator-visible surfaces and reserving `buildPublicUrl()` for outbound delivery only.

## What happens when the sandbox is already running

When the sandbox is running and a channel message arrives, both Slack and Telegram take a fast path:

- **Slack** forwards the validated payload directly to `/slack/events` on the gateway (port 3000).
- **Telegram** forwards the raw update directly to the native Telegram handler (port 8787).

No Workflow is started. No boot message is sent. The response comes back as quickly as the gateway can process it.

## What happens when the sandbox is stopped

When the sandbox is stopped and a channel message arrives, both platforms use a durable delivery path powered by Vercel Workflow:

1. **Telegram only:** a boot message ("Starting up…") is sent to the user so they know the sandbox is waking.
2. The Workflow step restores the sandbox if needed.
3. The message is sent to the gateway via `POST /v1/chat/completions`.
4. The reply is delivered back to the originating channel.
5. **Telegram only:** the boot message is deleted after the reply is delivered.

The Workflow-based path is durable — it survives function restarts and retries on transient failures. This is why channels require Upstash: the durable state backing makes delivery reliable even when the sandbox needs to wake up.

## Troubleshooting

### Channel connect is blocked

The admin panel shows a channel as blocked when deployment prerequisites are still failing. Check the preflight report for hard blockers: missing public origin, unavailable AI Gateway auth, or missing Upstash on Vercel. Resolve the blockers and try again.

### Preflight passes but channel still is not trusted

This means the full runtime path has not been verified yet. Preflight only checks config. Run destructive launch verification to prove the sandbox can boot, answer completions, and wake from sleep. Once it passes, `channelReadiness.ready` becomes `true` for the current deployment.

### Slack works but Telegram registration fails on a protected deployment

Telegram is hitting Vercel's Deployment Protection, not app auth. Unlike Slack, Telegram cannot use the bypass query parameter because `setWebhook` silently drops registrations with extra parameters. Configure a Deployment Protection Exception for the Telegram webhook path, or disable Deployment Protection if your use case allows it.

### Launch verification phases look mostly healthy but overall result is false

Even when individual phases pass, `ok: false` means something is still wrong. Check these fields in the verification result:

- `runtime.dynamicConfigVerified` — was the running sandbox config in sync with the deployment?
- `sandboxHealth.configReconciled` — did stale config get successfully fixed?
- `runtime.restorePreparedStatus` — is the restore target reusable for future boots?

A partial pass with `ok: false` usually means dynamic config drifted or the restore target is not sealed. Re-running destructive verification after fixing the underlying issue is the right next step.

| Symptom | Likely meaning | Where to look |
| ------- | -------------- | ------------- |
| Channel connect is blocked | Deployment prerequisites are still failing | preflight checks, required actions |
| Preflight passes but channel still is not trusted | Full runtime path has not been verified yet | `channelReadiness.ready`, destructive launch verification |
| Slack works but Telegram registration fails on a protected deployment | Telegram is hitting protection behavior, not app auth | deployment protection exception, Telegram webhook URL behavior |
| Launch verification phases look mostly healthy but overall result is false | Dynamic config or restore-target state is still unhealthy | `runtime.dynamicConfigVerified`, `sandboxHealth.configReconciled`, `restorePreparedStatus` |

## Related docs

- [Preflight and Launch Verification](preflight-and-launch-verification.md) — how readiness is checked and proven
- [Deployment Protection](deployment-protection.md) — bypass secret behavior and display-safe URL rules
- [Sandbox Lifecycle and Restore](lifecycle-and-restore.md) — how the sandbox moves through states
- [API Reference](api-reference.md) — endpoint and payload shapes for channel routes and launch verification
- [Environment Variables](environment-variables.md) — full env var reference including channel-relevant config
