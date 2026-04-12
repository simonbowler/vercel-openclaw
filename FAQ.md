# FAQ

## OpenClaw is currently pinned to {{OPENCLAW_VERSION}}. Why?

This project runs the latest verified OpenClaw release for Vercel Sandbox. The pinned version is the newest version verified against this deployment's install, sleep, wake, and resume flow.

## What does "verified" mean?

It means the release has been checked against the workflow that matters here: install, run, sleep, wake, and resume. That matters because a sandbox waking up is a lot like restarting OpenClaw on your Mac mini. The process may start, but if channels or history take too long to recover, the product feels broken.

## Why not just update to the newest release?

Recent upstream releases have introduced regressions in this flow. Examples include [#63225](https://github.com/openclaw/openclaw/issues/63225), which forced a rollback due to a missing dependency, and [#63863](https://github.com/openclaw/openclaw/issues/63863), where resume after wake became slow enough to disrupt Telegram and other channels. Until a release is verified here, it remains unverified for this deployment.

## How do I recover from a bad update?

To inspect the current sandbox:

```bash
npx sandbox connect <sandbox_id>
```

To preserve the current state before rollback:

```bash
npx sandbox snapshot <sandbox_id> --stop
```

To restore a known-good state:

```bash
npx sandbox snapshots list
npx sandbox create --snapshot <snapshot_id>
```

## Will this always require pinning?

The current plan is to keep using a pinned version until release coverage improves. We are working with the OpenClaw team on tests that exercise restart, sleep, wake, and resume behavior so these regressions are caught earlier.
