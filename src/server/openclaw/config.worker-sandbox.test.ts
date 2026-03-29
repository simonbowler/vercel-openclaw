import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWorkerSandboxSkill,
  buildWorkerSandboxScript,
  OPENCLAW_WORKER_SANDBOX_SCRIPT_PATH,
} from "@/server/openclaw/config";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("worker-sandbox skill describes the execute entrypoint and JSON contract", () => {
  const skill = buildWorkerSandboxSkill();

  assert.match(skill, /^---\nname: worker-sandbox/m);
  assert.match(skill, /Execute a bounded job in a fresh Vercel Sandbox/);
  assert.match(skill, new RegExp(escapeRegExp(OPENCLAW_WORKER_SANDBOX_SCRIPT_PATH)));
  assert.match(skill, /WorkerSandboxExecuteRequest shape/);
  assert.match(skill, /capturePaths/);
  assert.match(skill, /Response shape/);
  assert.match(skill, /capturedFiles/);
  assert.match(skill, /stdout/);
  assert.match(skill, /stderr/);
});

test("worker-sandbox script posts to the internal execute route with bearer auth", () => {
  const script = buildWorkerSandboxScript();

  assert.match(script, /Could not resolve host origin from openclaw\.json/);
  assert.match(script, /worker-sandbox:v1\\0/);
  assert.match(script, /authorization:\s*"Bearer "\s*\+\s*bearer/);
  assert.match(script, /\/api\/internal\/worker-sandboxes\/execute/);
  assert.match(script, /method:\s*"POST"/);
  assert.match(script, /"content-type":\s*"application\/json"/);
});
