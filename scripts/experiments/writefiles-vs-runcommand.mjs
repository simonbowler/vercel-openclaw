/**
 * Experiment 7: writeFiles vs runCommand for file creation
 *
 * Measures overhead of writeFiles vs runCommand('sh', ['-c', 'cat <<...'])
 * for creating files. Also tests batch sizes: 1, 5, 20 files.
 *
 * 10 iterations each, computes p50/p95.
 */

import { readFileSync } from "node:fs";

// Load OIDC credentials from .env.local
const content = readFileSync(
  new URL("../../.env.local", import.meta.url),
  "utf-8",
);
for (const line of content.split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq === -1) continue;
  const k = t.slice(0, eq);
  let v = t.slice(eq + 1);
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  if (!process.env[k]) process.env[k] = v;
}

const { Sandbox } = await import("@vercel/sandbox");

const ITERATIONS = 10;
const FILE_CONTENT = "hello world\nline two\nline three\n";

function percentile(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  return {
    min: sorted[0],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
    mean: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
  };
}

function makeFiles(count, prefix) {
  const files = [];
  for (let i = 0; i < count; i++) {
    files.push({ path: `/tmp/${prefix}_${i}.txt`, content: FILE_CONTENT });
  }
  return files;
}

console.log("Creating fresh sandbox (1 vCPU)...");
const createStart = performance.now();
const sandbox = await Sandbox.create({
  ports: [3000],
  timeout: 60_000,
  resources: { vcpus: 1 },
});
const createMs = Math.round(performance.now() - createStart);
console.log(`Sandbox created in ${createMs}ms — id: ${sandbox.id}\n`);

const results = {};

// --- Test 1: writeFiles single file ---
for (const batchSize of [1, 5, 20]) {
  const label = `writeFiles x${batchSize}`;
  const times = [];

  // Warm-up
  await sandbox.writeFiles(makeFiles(batchSize, `warmup_wf_${batchSize}`));

  for (let i = 0; i < ITERATIONS; i++) {
    const files = makeFiles(batchSize, `wf_${batchSize}_${i}`);
    const start = performance.now();
    await sandbox.writeFiles(files);
    const elapsed = Math.round(performance.now() - start);
    times.push(elapsed);
  }

  const s = stats(times);
  results[label] = { ...s, raw: times };
  console.log(
    `${label.padEnd(30)} min=${s.min}ms  p50=${s.p50}ms  p95=${s.p95}ms  max=${s.max}ms  mean=${s.mean}ms`,
  );
}

// --- Test 2: runCommand with cat/heredoc for single file ---
{
  const label = "runCommand cat x1";
  const times = [];

  // Warm-up
  await sandbox.runCommand("sh", [
    "-c",
    `cat > /tmp/warmup_rc.txt << 'RCEOF'\n${FILE_CONTENT}\nRCEOF`,
  ]);

  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    await sandbox.runCommand("sh", [
      "-c",
      `cat > /tmp/rc_${i}.txt << 'RCEOF'\n${FILE_CONTENT}\nRCEOF`,
    ]);
    const elapsed = Math.round(performance.now() - start);
    times.push(elapsed);
  }

  const s = stats(times);
  results[label] = { ...s, raw: times };
  console.log(
    `${label.padEnd(30)} min=${s.min}ms  p50=${s.p50}ms  p95=${s.p95}ms  max=${s.max}ms  mean=${s.mean}ms`,
  );
}

// --- Test 3: runCommand writing 5 files in one shell command ---
for (const batchSize of [5, 20]) {
  const label = `runCommand cat x${batchSize}`;
  const times = [];

  // Build a shell script that writes N files
  function buildScript(prefix) {
    let script = "";
    for (let j = 0; j < batchSize; j++) {
      script += `cat > /tmp/${prefix}_${j}.txt << 'RCEOF'\n${FILE_CONTENT}\nRCEOF\n`;
    }
    return script;
  }

  // Warm-up
  await sandbox.runCommand("sh", ["-c", buildScript(`warmup_rcb_${batchSize}`)]);

  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    await sandbox.runCommand("sh", ["-c", buildScript(`rcb_${batchSize}_${i}`)]);
    const elapsed = Math.round(performance.now() - start);
    times.push(elapsed);
  }

  const s = stats(times);
  results[label] = { ...s, raw: times };
  console.log(
    `${label.padEnd(30)} min=${s.min}ms  p50=${s.p50}ms  p95=${s.p95}ms  max=${s.max}ms  mean=${s.mean}ms`,
  );
}

console.log("\n--- Raw timings (ms) ---");
for (const [label, r] of Object.entries(results)) {
  console.log(`${label}: [${r.raw.join(", ")}]`);
}

console.log("\nStopping sandbox...");
await sandbox.stop();
console.log("Done.");
