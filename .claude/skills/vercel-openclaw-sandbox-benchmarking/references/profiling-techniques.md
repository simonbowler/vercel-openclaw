# Profiling Techniques

## In-Sandbox Profiling

Upload a profiling script via `sandbox.writeFiles`, execute with `sandbox.runCommand`, parse output.

### Time gateway startup (Node vs Bun)

```bash
#!/bin/bash
export OPENCLAW_CONFIG_PATH=/home/vercel-sandbox/.openclaw/openclaw.json
export OPENCLAW_GATEWAY_TOKEN="$gateway_token"

# Node.js timing
start=$(date +%s%N)
setsid node /home/vercel-sandbox/.global/npm/bin/openclaw gateway --port 3000 --bind loopback &
gw_pid=$!
attempts=0
while [ $attempts -lt 120 ]; do
  attempts=$((attempts+1))
  if curl -s -f --max-time 1 http://localhost:3000/ 2>/dev/null | grep -q 'openclaw-app'; then
    end=$(date +%s%N)
    echo "node: $((  (end-start)/1000000 ))ms attempts=$attempts"
    break
  fi
  sleep 0.1
done
kill $gw_pid 2>/dev/null; wait $gw_pid 2>/dev/null

# Bun timing (same pattern with bun instead of node)
```

### V8 Compile Cache Test

```bash
# Prime the cache
mkdir -p /home/vercel-sandbox/.node-compile-cache
NODE_COMPILE_CACHE=/home/vercel-sandbox/.node-compile-cache \
  openclaw gateway --port 3000 --bind loopback &
# Wait for ready, then kill, then snapshot

# Restore and compare with/without cache env set
```

Finding: openclaw already calls `module.enableCompileCache()` internally, and the cache (~25MB, 4207 files) provides no measurable improvement because the bottleneck is module resolution I/O, not V8 compilation.

### Package Size Analysis

```bash
du -sh /home/vercel-sandbox/.global/npm/lib/node_modules/openclaw  # ~577MB
find ... -name "*.js" | wc -l  # ~10,148 files
node --version  # v22.22.0
```

### Bun Compatibility Verification

Use `scripts/bun-verify.sh` inside a sandbox. Tests:
1. Homepage serves `openclaw-app` marker
2. `/v1/chat/completions` endpoint responds
3. Force-pair works under node (force-pair uses node:crypto)
4. Gateway process stays alive
5. No crashes/panics in logs
6. Static assets served

### API Round-Trip Cost

Each `sandbox.runCommand()` and `sandbox.writeFiles()` call costs ~2-5s in platform round-trip overhead. Minimize the number of SDK calls on the hot path:

| Operation | Typical cost |
|-----------|-------------|
| `Sandbox.create()` from snapshot | ~1.4s |
| `sandbox.writeFiles()` (any size) | ~5-9s |
| `sandbox.runCommand()` (any command) | ~2-5s |
| `sandbox.readFileToBuffer()` | ~2-3s |
| `sandbox.updateNetworkPolicy()` | ~0.1s |

Key insight: the cost is dominated by API round-trip, not data size. Writing 2 bytes costs the same as writing 2MB.

## Benchmark Automation Patterns

### Production stop/restore cycle

```bash
ADMIN_SECRET=$(grep -E '^ADMIN_SECRET=' .env.local | sed 's/^ADMIN_SECRET=//' | tr -d '"')
BASE="https://vercel-openclaw-prod.labs.vercel.dev"

# Stop
curl -s -X POST -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" "$BASE/api/admin/stop"

# Restore and get metrics
curl -s -X POST -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  "$BASE/api/admin/ensure?wait=1&timeoutMs=180000" | \
  node -e "..." # parse restoreMetrics
```

### Direct SDK benchmark loop

See `scripts/bench-sandbox-direct.mjs` — creates sandbox, installs openclaw, snapshots, then loops N restore cycles printing per-phase JSON.
