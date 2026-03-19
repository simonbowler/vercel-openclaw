# Benchmark Results

Historical data from restore speed optimization work (March 2026).

## Environment
- 1 vCPU Vercel Sandbox
- `openclaw@latest` (2026.3.13), 577MB installed, 10,148 JS files
- Node.js v22.22.0, Bun 1.3.11
- Tool: `scripts/bench-sandbox-direct.mjs` (direct SDK)

## Optimization Journey

### Baseline (before changes)
Host-side polling: 120x `sandbox.runCommand("curl")` + serial force-pair + serial credential writes.

| Phase | p50 |
|-------|-----|
| sandboxCreate | 1,861ms |
| tokenWrite | 6,540ms |
| assetSync | 291ms |
| startupScript | 15,290ms |
| localReady | 8,770ms |
| **total** | **21,508ms** |

### After in-sandbox readiness + force-pair deferral
| Phase | p50 | Delta |
|-------|-----|-------|
| startupScript | 11,217ms | -4,073ms |
| localReady | 6,781ms | -1,989ms |
| **total** | **13,902ms** | **-7,606ms** |

### After env-based credentials (eliminate tokenWriteMs)
| Phase | p50 | Delta |
|-------|-----|-------|
| tokenWrite | 0ms | -6,540ms |
| assetSync | 5,716ms | +5,425ms (was hidden in tokenWrite) |
| **total** | **~15,097ms** | -6,411ms from baseline |

### Bun vs Node.js gateway boot (isolated test)
| Runtime | Ready time | Attempts |
|---------|-----------|----------|
| Node.js v22.22.0 | 7,015ms | 60 |
| Bun 1.3.11 | 4,724ms | 40 |

### V8 Compile Cache (no effect)
| Condition | Ready time |
|-----------|-----------|
| Without compile cache | ~7,016ms |
| With primed compile cache | ~7,379ms |
openclaw already calls `module.enableCompileCache()` internally.

## Current Bottleneck Breakdown (~15s total)

| Component | Time | % | Notes |
|-----------|------|---|-------|
| Sandbox.create (platform) | ~1.4s | 9% | Not controllable |
| assetSync (writeFiles for openclaw.json) | ~5.7s | 38% | Next optimization target |
| Gateway boot (Node.js loading 577MB) | ~7.4s | 49% | Bun cuts to ~4.7s |
| Firewall sync | ~0.1s | 1% | Concurrent, negligible |

## Next Optimization Targets
1. Overlap dynamic asset sync with boot (pass config via env or defer)
2. Bun in production snapshots (installed during bootstrap, used by fast-restore)
3. Consider pre-bundled openclaw binary to reduce module resolution I/O
