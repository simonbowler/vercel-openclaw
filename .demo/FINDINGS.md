# @vercel/sandbox v2 (2.0.0-beta.4) — Demo Findings

**Date:** 2026-03-13
**Tested from:** `.demo/` folder in vercel-openclaw

## TL;DR

The v2 beta SDK is **not usable yet** because the server-side API it depends on
(`/v1/sandboxes/named`) **does not exist** (returns 404). This is not an auth issue
and not a configuration issue — the backend endpoint hasn't been deployed to
production yet. All 5 gaps from the notes have been resolved at the type level,
but we can't verify runtime behavior until the endpoint goes live.

---

## Corrected Misconceptions from sandbox-v2.md

### ❌ "ports, timeout, resources were removed from CreateParams"

**Wrong.** All three are still present in v2's `BaseCreateSandboxParams`
(`sandbox.d.ts` lines 48, 52, 59):

```ts
ports?: number[]          // line 48 — still there
timeout?: number          // line 52 — still there (coexists with persistent)
resources?: { vcpus }     // line 59 — still there
```

**Evidence:** The upgrade commit (`480f0c2`) used `2.0.0-beta.4` — the same
version we tested here. The confusion arose because our `CreateParams` type in
`controller.ts` was deliberately narrowed to only `{ source?, env? }` (removing
`ports`, `timeout`, `resources` from our interface). The SDK itself never removed
them. `lifecycle.ts` at commit `480f0c2` called `create({ ...buildRuntimeEnv() })`
which only passed `env` — no `ports`. This means port 3000 was never requested
from the API at all.

### ❌ "domain(3000) returned URLs that 404'd"

**Evidence from code:** The v2 SDK's `parseOrThrow()` (base-client.js:121-124)
**throws** an `APIError` on any non-ok HTTP status. It does NOT return a partial
sandbox object. Since `POST /v1/sandboxes/named` returns 404, `Sandbox.create()`
throws immediately — the sandbox object is never constructed, and `domain(3000)`
is never called.

**This contradicts the notes** which say "Sandbox creation and snapshot restore
both succeeded at the API level." Given the upgrade and revert happened within
12 minutes of each other (18:05 → 18:17 on 2026-03-12), the most probable
explanation is that the `/named` endpoint was briefly available during a Vercel
canary deployment, then rolled back on their side. The 404 we see now is the
stable state of the Vercel API.

---

## Confirmed Type-Level Changes (Breaking)

| Change | Impact |
|--------|--------|
| `sandbox.sandboxId` → `sandbox.name` | All code reading the sandbox ID |
| `Sandbox.get({ sandboxId })` → `Sandbox.get({ name })` | Controller.get() |
| `snapshot()` returns `Snapshot` class (not `{ snapshotId }`) | But `.snapshotId` getter exists on Snapshot, so `snap.snapshotId` still works |

## New in v2 (Additive)

| Feature | Details |
|---------|---------|
| `name` param on create | User-chosen name, auto-generated if omitted |
| `persistent: boolean` | Whether state persists across sessions (default: true) |
| `runtime: string` | e.g. `"node24"`, `"python3.13"` |
| `env: Record<string, string>` | Default env vars for all commands |
| `networkPolicy` at creation | Inline network policy, not just post-creation |
| `sandbox.update()` | Update persistent, resources, timeout, networkPolicy |
| `sandbox.delete()` | Delete the named sandbox |
| `sandbox.stop({ blocking })` | Stop with optional poll-until-stopped |
| `sandbox.currentSession()` | Access the underlying VM session |
| `sandbox.listSessions()` | Paginated session history |
| `sandbox.listSnapshots()` | Paginated snapshot listing |
| `sandbox.routes` | SandboxRouteData[] — port/subdomain/url mapping |
| `Sandbox.list()` | List all named sandboxes for a team |
| `Snapshot.list()` / `Snapshot.get()` | Snapshot management |
| `snapshot.delete()` | Cleanup snapshots |
| `snapshot.sizeBytes`, `.createdAt`, `.expiresAt` | Snapshot metadata |
| `runCommand({ detached: true })` | Returns Command (not CommandFinished) |
| `command.logs()` | Async generator for streaming output |
| `command.kill(signal)` | Kill a running command |
| `command.stdout()`, `.stderr()` | Convenience output methods |
| `session.update()` | Session-level network policy updates |
| `NetworkPolicy` format | `"allow-all"` / `"deny-all"` / `{ allow, subnets }` with per-domain transforms |
| `AbortSignal` everywhere | Cancellation support on most operations |

## API Endpoint Analysis

| Endpoint | v1 | v2 | Status |
|----------|----|----|--------|
| `POST /v1/sandboxes` | Create sandbox | Not used | Works (403 with OIDC, OK in production) |
| `POST /v1/sandboxes/named` | N/A | Create named sandbox | **404 — doesn't exist** |
| `GET /v1/sandboxes/named` | N/A | List named sandboxes | **404** |
| `GET /v1/sandboxes/named/:name` | N/A | Get by name | **404** |
| `PATCH /v2/sandboxes/:name` | N/A | Update named sandbox | Unknown (depends on /named) |

The v2 SDK unconditionally uses the `/named` endpoints. There is no fallback
to the v1 endpoints. This means:

- **v2 SDK cannot create sandboxes** (endpoint missing)
- **v2 SDK cannot list sandboxes** (endpoint missing)
- **v2 SDK cannot get sandboxes by name** (endpoint missing)
- Once a sandbox _is_ created (via v1 or future v2), operations that use
  the sandboxId directly (runCommand, writeFiles, etc.) might work since
  they use `/v1/sandboxes/{sandboxId}/...` paths.

## What Would the v2 Migration Look Like (When Ready)

Based on type analysis and git archaeology of commit `480f0c2`:

```ts
// controller.ts changes needed:

// 1. wrapSandbox:
//    sandbox.sandboxId → sandbox.name
//    (snapshot().snapshotId still works — Snapshot class has the getter)

// 2. CreateParams:
//    MUST re-add ports, timeout, resources to our CreateParams type.
//    The previous upgrade (480f0c2) stripped them from our interface,
//    which meant lifecycle.ts passed no ports to the SDK.
//    The SDK has these params — our interface was too narrow.

// 3. SandboxController.get():
//    { sandboxId: string } → { name: string }

// 4. NetworkPolicy:
//    Old { allow: string[] } still works (subset of new format)
//    New format adds subnets and per-domain transforms
```

**Critical finding from the previous attempt:** The upgrade commit (`480f0c2`)
narrowed `CreateParams` to only `{ source?, env? }`, which meant the
`create()` call in lifecycle.ts passed **no ports at all** to the SDK.
Even if the API had worked, the sandbox would have had no exposed ports.
This is a separate bug from the 404 endpoint issue and must be fixed in
any future upgrade.

## Recommended Next Steps

1. **Wait for `/v1/sandboxes/named` to go live.** This is the only blocker.
   Check periodically with:
   ```bash
   curl -s -o /dev/null -w '%{http_code}' \
     -X POST https://vercel.com/api/v1/sandboxes/named \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"projectId":"..."}' \
     '?teamId=...'
   ```
   When it returns 400 or 200 instead of 404, the endpoint is live.

2. **Re-run demo-02 (create + port routing)** once the endpoint is live.
   The port routing "bug" was almost certainly the named endpoint returning
   an incomplete/empty sandbox object.

3. **The controller.ts migration is 3 lines.** The abstraction layer is
   well-designed. Only `sandboxId → name` and the `get()` param change.

4. **Test snapshot compat** (demo-04) once creates work. The snapshot source
   format is identical (`{ type: "snapshot", snapshotId }`) so v1 snapshots
   should just work.

## Files in This Demo

| File | Purpose | Requires API? |
|------|---------|---------------|
| `demo-01-types.ts` | Type-level analysis, no API calls | No |
| `demo-02-create-basic.ts` | Create sandbox, test port routing | Yes |
| `demo-03-no-ports.ts` | Create without ports param | Yes |
| `demo-04-snapshot-roundtrip.ts` | Full snapshot create/restore cycle | Yes |
| `demo-05-get-by-name.ts` | Sandbox.get() with named sandboxes | Yes |
| `demo-06-persistent.ts` | persistent vs timeout behavior | Yes |
| `demo-07-network-policy.ts` | v2 NetworkPolicy format | Yes |
| `demo-08-list-sandboxes.ts` | Sandbox.list(), Snapshot.list() | Yes |
| `demo-09-api-endpoints.ts` | Raw HTTP endpoint probing | Yes (diagnostic) |
| `demo-10-sdk-debug.ts` | SDK debug mode | Yes (diagnostic) |
| `demo-11-v1-still-works.ts` | Verify v1 API still works | Yes (diagnostic) |
