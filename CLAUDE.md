# CLAUDE.md

This file explains how to work in `vercel-openclaw`.

## Project goal

`vercel-openclaw` is a single-instance Next.js app that manages exactly one Vercel Sandbox running OpenClaw.

The app handles:

- auth in front of the proxy
- on-demand sandbox create and restore
- proxying the OpenClaw UI at `/gateway`
- HTML injection for WebSocket rewriting and gateway token handoff
- learning and enforcing egress firewall state
- Slack, Discord, and Telegram channel webhooks through the app

The app does not handle:

- multiple sandboxes
- per-sandbox passwords
- admin bearer tokens

## Commands

Run these from the repository root:

```bash
pnpm install
pnpm dev
pnpm lint
pnpm test
pnpm typecheck
pnpm build
```

Tests use `node:test` through `tsx --test`.

### Remote smoke testing

```bash
pnpm smoke:remote --base-url https://my-app.vercel.app
pnpm smoke:remote --base-url https://my-app.vercel.app --destructive --timeout 180
pnpm smoke:remote --base-url https://my-app.vercel.app --json-only --auth-cookie "session=..."
pnpm smoke:remote --base-url https://my-app.vercel.app --request-timeout 10
```

Flags:

- `--base-url` (required) — the deployed app URL to test
- `--destructive` — include destructive phases (ensure, snapshot, restore). Omit for safe read-only checks only.
- `--timeout` — timeout in seconds for polling phases (default: 120)
- `--request-timeout` — per-request fetch timeout in seconds (default: 30)
- `--auth-cookie` — auth cookie value, overrides `SMOKE_AUTH_COOKIE` env var. The raw value is never logged.
- `--json-only` — suppress all human-readable stderr output; emit only the JSON report to stdout

Environment:

- `SMOKE_AUTH_COOKIE` — encrypted session cookie for `sign-in-with-vercel` mode. Not needed for `deployment-protection` mode where Vercel handles auth upstream. Overridden by `--auth-cookie` if both are set.

Output:

- Structured JSON report to stdout: `{ schemaVersion: 1, passed: boolean, phases: PhaseResult[], totalMs: number }`
- Human-readable progress to stderr (suppressed by `--json-only`)
- Exit code 0 (all pass) or 1 (any fail)

Safe phases (always run): `health`, `status`, `gatewayProbe`, `firewallRead`, `channelsSummary`, `sshEcho`, `chatCompletions`, `channelRoundTrip`.
Destructive phases (opt-in): `ensureRunning`, `chatCompletions`, `channelRoundTrip`, `channelWakeFromSleep`, `chatCompletions` (post-wake).

Channel phases (`channelRoundTrip`, `channelWakeFromSleep`) read signing secrets from `/api/admin/channel-secrets`, construct properly-signed webhooks, and verify the full ingestion + drain + completions pipeline. They gracefully skip if no channels are configured.

## Architecture

## Control plane

State lives in one metadata record described in `src/shared/types.ts`.

Channel config is stored in that same metadata record. Durable webhook queues and session history use store-backed side keys.

Backends:

- `src/server/store/upstash-store.ts`
- `src/server/store/memory-store.ts`

Selection happens in `src/server/store/store.ts`.

Rules:

- prefer the Upstash REST backend for persistent behavior
- the memory backend is for local development only
- any change to metadata shape should be reflected in `ensureMetaShape`

## Lifecycle

Main file:

- `src/server/sandbox/lifecycle.ts`

Important behavior:

- `ensureSandboxRunning()` schedules create or restore work with `after()` and returns a waiting state to the caller
- `stopSandbox()` snapshots and stops
- `snapshotSandbox()` currently delegates to the same snapshot-and-stop flow
- `touchRunningSandbox()` extends sandbox timeout
- `probeGatewayReady()` fetches the sandbox root and checks for `openclaw-app`

Statuses:

- `uninitialized`
- `creating`
- `setup`
- `booting`
- `running`
- `stopped`
- `restoring`
- `error`

If you change lifecycle behavior, keep the waiting-page flow intact. The proxy depends on it.

## OpenClaw bootstrap

Main files:

- `src/server/openclaw/config.ts`
- `src/server/openclaw/bootstrap.ts`

Bootstrap responsibilities:

- install `openclaw`
- write `openclaw.json`
- write the gateway token file
- write the AI Gateway key file
- write the restore startup script
- wait for the gateway to become healthy

The startup script also installs shell hooks used for firewall learning.

## Proxy

Main files:

- `src/app/gateway/[[...path]]/route.ts`
- `src/server/proxy/proxy-route-utils.ts`
- `src/server/proxy/htmlInjection.ts`
- `src/server/proxy/waitingPage.ts`

Critical rules:

- auth must happen before proxying any HTML that contains the injected gateway token
- do not remove the WebSocket rewrite logic without replacing it with an equivalent approach
- preserve the heartbeat `POST /api/status` behavior used by the injected script
- block or rewrite upstream redirects so the app does not hand the browser to an external origin unexpectedly

## Firewall

Main files:

- `src/server/firewall/domains.ts`
- `src/server/firewall/policy.ts`
- `src/server/firewall/state.ts`

Mode mapping:

- `disabled` -> `allow-all`
- `learning` -> `allow-all`
- `enforcing` -> `{ allow: [...] }`

Learning flow:

- shell commands are written to `/tmp/shell-commands-for-learning.log`
- status polling ingests that log
- domains are extracted and stored in metadata

If you change learning behavior, keep it deterministic and testable.

## Channels

Main files:

- `src/server/channels/driver.ts`
- `src/server/channels/state.ts`
- `src/server/channels/slack/adapter.ts`
- `src/server/channels/telegram/adapter.ts`
- `src/server/channels/telegram/bot-api.ts`
- `src/server/channels/discord/adapter.ts`
- `src/server/channels/discord/application.ts`

Behavior:

- public webhook routes validate requests and enqueue work
- drainers restore the sandbox on demand and forward messages to `/v1/chat/completions`
- replies are sent back through the platform APIs, not through the OpenClaw UI proxy
- Slack uses threaded replies
- Telegram uses webhook-secret validation and Bot API replies
- Discord uses deferred interaction responses and can register `/ask`
- `/api/cron/drain-channels` can replay deferred queue work when `CRON_SECRET` is configured

If you change queue semantics, keep the webhook acknowledgment path fast and preserve retry behavior.

## Auth

Main files:

- `src/server/auth/session.ts`
- `src/server/auth/vercel-auth.ts`

Supported modes:

- `deployment-protection`
- `sign-in-with-vercel`

Notes:

- `deployment-protection` is the default if `VERCEL_AUTH_MODE` is unset
- `sign-in-with-vercel` uses encrypted cookie sessions and verifies the ID token against Vercel's JWKS
- access tokens are refreshed before expiry
- refresh failure should clear the session and force a new login

## Admin UI

Main file:

- `src/components/admin-shell.tsx`

The admin page is intentionally small. It is a control surface, not a dashboard framework.

## Important implementation constraints

- Do not add `export const runtime = "nodejs"` to route handlers. This repo uses `cacheComponents: true` in `next.config.ts`, and explicit `runtime` exports break the Next.js 16 build.
- Keep the sandbox exposed on port `3000` unless you update bootstrap, lifecycle, proxy, and docs together.
- `POST /api/admin/snapshot` currently snapshots and stops. If you change that to a hot snapshot flow, update the README and this file.
- If you add environment variables, update `.env.example`, `README.md`, and this file in the same change.
- If you change metadata shape, update tests and migration logic in `ensureMetaShape`.

## Verification

Before considering work done, run:

```bash
pnpm lint
pnpm test
pnpm typecheck
pnpm build
```

## Current sharp edges

- The first automatic bootstrap does not create a snapshot yet.
- The memory store is not safe for production persistence.
- Firewall learning is based on shell command observation, not full traffic inspection.
- Channel webhook durability depends on the store backend. Use Upstash when channels matter.
