# Restore Benchmark — Baseline vs Hot Spare — 2026-04-02

## Deployment

- Base URL:
- Commit:
- OPENCLAW_HOT_SPARE_ENABLED (baseline): false
- OPENCLAW_HOT_SPARE_ENABLED (hot-spare): true

## Commands

### Baseline

```bash
node scripts/benchmark-restore.mjs \
  --base-url "$BASE_URL" \
  --cycles 5 \
  --variant baseline \
  --format json > baseline.jsonl
```

### Hot spare

```bash
node scripts/benchmark-restore.mjs \
  --base-url "$BASE_URL" \
  --cycles 5 \
  --variant hot-spare \
  --format json > hot-spare.jsonl
```

## Summary JSON

### baseline.jsonl

```json
PASTE_SUMMARY_LINE_HERE
```

### hot-spare.jsonl

```json
PASTE_SUMMARY_LINE_HERE
```

## Decision Table

| Variant | p50 totalMs | p50 sandboxCreateMs | hot-spare hit rate | p50 promotionMs | top reject reason |
| --- | --- | --- | --- | --- | --- |
| baseline | | | | | |
| hot-spare | | | | | |

## Verdict

Adopt hot-spare by default: yes/no

Reason:

If no, next action:

## Decision Gate (from plan-05)

- If p50 `totalMs` drops by ≥ 2 seconds with hot-spare: **adopt as default strategy**.
- If hot-spare misses dominate (snapshot/config/asset mismatch): investigate
  freshness propagation before re-measuring.
- If `sandboxCreateMs` is already small (< 1.5s): the spare overhead may not
  justify the resource cost — consider closing this plan.

## How to Populate

```bash
BASE_URL="https://my-app.vercel.app"

node scripts/benchmark-restore.mjs \
  --base-url "$BASE_URL" \
  --cycles 5 \
  --variant baseline \
  --format json > baseline.jsonl

node scripts/benchmark-restore.mjs \
  --base-url "$BASE_URL" \
  --cycles 5 \
  --variant hot-spare \
  --format json > hot-spare.jsonl

# Extract the summary lines
tail -n 1 baseline.jsonl
tail -n 1 hot-spare.jsonl
```
