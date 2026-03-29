# Architecture

## What this app is

`vercel-openclaw` is a single-instance Next.js control plane for one OpenClaw sandbox on Vercel.

It handles:

- admin auth in front of the proxy
- creating and restoring the sandbox on demand
- proxying the OpenClaw UI at `/gateway`
- injecting the gateway token into proxied HTML so WebSocket connections and auth work through the app
- learning and enforcing egress firewall rules
- receiving Slack and Telegram webhooks and delivering them to OpenClaw

It does not handle:

- multiple sandboxes
- per-sandbox passwords

## The two planes

### Control plane

The control plane is a single metadata record stored in Upstash Redis (or an in-memory store for local dev). It tracks the sandbox ID, snapshot ID, lifecycle status, firewall state, gateway token, and channel configuration.

The store backend is selected at startup. Upstash is required for production because channels, cron wake, and snapshot history all depend on durable state.

### Enforcement plane

The enforcement plane is the actual Vercel Sandbox plus its network policy. The app talks to it through the `@vercel/sandbox` SDK to create, restore, snapshot, and update the sandbox network policy.

## Request flow to `/gateway`

1. The browser requests `/gateway`.
2. The app authenticates the request (admin-secret cookie or Vercel OAuth session).
3. If the sandbox is not running, the app schedules create or restore work with `after()` and returns a waiting page. The browser polls until the sandbox is ready.
4. Once the sandbox is running and the gateway is healthy, the app proxies the request to port `3000` inside the sandbox.
5. HTML responses are rewritten so WebSocket connections route through the app and the gateway token is injected for client-side auth.

## Main subsystems

- **Auth** — session cookies, admin-secret exchange, optional Vercel OAuth
- **Sandbox lifecycle** — create, restore, stop, snapshot, health checks
- **Proxy** — reverse proxy to the sandbox, HTML injection, waiting page
- **Firewall** — domain learning from shell commands, policy enforcement
- **Channels** — Slack and Telegram webhook ingestion, boot-message flow, durable delivery via Workflow DevKit
- **Deployment readiness** — preflight config checks, launch verification runtime checks, watchdog cron

## Where to read next

- [Sandbox Lifecycle and Restore](lifecycle-and-restore.md) — how the sandbox moves through states and how restores work
- [Preflight and Launch Verification](preflight-and-launch-verification.md) — how the app proves it is correctly deployed and operational
- [Channels and Webhooks](channels-and-webhooks.md) — Slack and Telegram setup, readiness, and webhook behavior
