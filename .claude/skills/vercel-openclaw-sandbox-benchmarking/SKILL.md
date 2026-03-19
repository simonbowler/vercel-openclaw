---
name: vercel-openclaw-sandbox-benchmarking
description: Benchmark and optimize Vercel Sandbox restore speed for the vercel-openclaw project. Use when measuring restore latency, running vCPU sweeps, comparing runtime performance (Node vs Bun), profiling startup phases, or optimizing the restore hot path. Triggers on "benchmark", "restore speed", "sandbox performance", "optimize restore", "vCPU sweep".
---

# Sandbox Restore Benchmarking

Techniques and tools for measuring and optimizing sandbox restore speed in vercel-openclaw.

## Quick Start

```bash
# Refresh OIDC credentials (required for direct SDK access)
vercel env pull .env.local

# Run direct SDK benchmark (creates real sandbox, installs openclaw, snapshots, restores)
node scripts/bench-sandbox-direct.mjs --cycles=5 --vcpus=1

# Reuse existing snapshot (skip bootstrap)
node scripts/bench-sandbox-direct.mjs --cycles=5 --vcpus=1 --snapshot-id=<snap_id>

# Production stop/restore via app API
node scripts/benchmark-restore.mjs --base-url "$APP_URL" --cycles=3
```

## Two Benchmark Approaches

### 1. Direct SDK (`bench-sandbox-direct.mjs`)
Uses `@vercel/sandbox` SDK directly. Measures raw platform + app overhead without proxy/admin layer. Best for isolating restore performance.

### 2. App API (`benchmark-restore.mjs`)
Hits the deployed app's HTTP endpoints. Measures end-to-end including Vercel function cold starts, auth, and proxy. Best for real-world timing.

## Restore Phase Budget

Every restore records per-phase timings in `lastRestoreMetrics` (visible via `/api/status`):

| Phase | What it measures | Optimization lever |
|-------|-----------------|-------------------|
| `sandboxCreateMs` | `Sandbox.create()` from snapshot | Platform cost (not controllable) |
| `tokenWriteMs` | Credential file writes | Pass via `Sandbox.create({ env })` to eliminate |
| `assetSyncMs` | Config + static file writes | Manifest-based skip for static; env for dynamic |
| `startupScriptMs` | Fast-restore script (gateway + readiness) | Bun runtime, in-sandbox polling, force-pair deferral |
| `localReadyMs` | In-sandbox curl loop until `openclaw-app` | Part of startupScript; reported from script JSON |
| `firewallSyncMs` | Network policy application | Runs concurrently with boot |
| `publicReadyMs` | External reachability probe | Skipped for background restores |
| `bootOverlapMs` | Wall clock of Promise.all(boot, firewall, cred-write) | Concurrency ceiling |

## Key Optimization Techniques

### 1. In-sandbox readiness polling
Move curl loop inside the bash script instead of 120 separate `sandbox.runCommand("curl")` host-side calls. Eliminates per-attempt control-plane round-trips.

### 2. Defer force-pair after readiness
Gateway serves initial page without device pairing. Moving `node .force-pair.mjs` after readiness prevents CPU contention on 1 vCPU.

### 3. Pass credentials via env at create time
`Sandbox.create({ env: { OPENCLAW_GATEWAY_TOKEN, AI_GATEWAY_API_KEY } })` lets the startup script read tokens from env, eliminating blocking `writeFiles` round-trips (~6-9s).

### 4. Bun for gateway startup
Bun loads the 577MB/10K-file openclaw package ~33% faster than Node.js v22. Install during bootstrap, snapshot it, use in fast-restore script with Node.js fallback.

### 5. Manifest-based static asset skip
SHA-256 manifest in snapshot lets unchanged static files skip `writeFiles` on repeat restores.

## Profiling a Sandbox

To investigate startup bottlenecks inside a real sandbox:

```bash
# Create sandbox from snapshot and run commands
node -e "
const { Sandbox } = await import('@vercel/sandbox');
const sbx = await Sandbox.create({ source: { type: 'snapshot', snapshotId: '<id>' }, ports: [3000], timeout: 300000, resources: { vcpus: 1 } });
// Run profiling commands
const r = await sbx.runCommand('node', ['--version']);
console.log(await r.output());
await sbx.snapshot(); // cleanup
"
```

See `references/profiling-techniques.md` for specific profiling patterns.

## Decision Rules

- Pin `OPENCLAW_PACKAGE_SPEC` and `OPENCLAW_SANDBOX_VCPUS` during benchmarks
- Run 5+ cycles minimum for stable p50/p95
- Compare branches with same snapshot, same vCPU, same package version
- Ship only if `totalMs` p50 improves AND p95 doesn't regress
- Always verify with `node scripts/verify.mjs` before and after

## References

- `references/profiling-techniques.md` - In-sandbox profiling, Node vs Bun comparison, compile cache testing
- `references/benchmark-results.md` - Historical benchmark data and optimization journey
- `references/architecture.md` - Restore flow architecture and phase dependencies
