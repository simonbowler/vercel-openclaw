#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";

const ROOT = process.cwd();
const DEFAULT_STEPS = ["contract", "lint", "test", "typecheck", "build"];

// Steps that bypass package.json scripts and run a direct command instead.
const DIRECT_STEP_COMMANDS = {
  contract: "node scripts/check-verifier-contract.mjs",
};

function emit(event, data = {}) {
  process.stdout.write(
    JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      ...data,
    }) + "\n",
  );
}

function parseSteps(argv) {
  const arg = argv.find((value) => value.startsWith("--steps="));
  if (!arg) return DEFAULT_STEPS;

  const parsed = arg
    .slice("--steps=".length)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return parsed.length > 0 ? parsed : DEFAULT_STEPS;
}

async function readPackageJson(root) {
  const raw = await readFile(path.join(root, "package.json"), "utf8");
  return JSON.parse(raw);
}

function buildScriptEnv(root) {
  const binDir = path.join(root, "node_modules", ".bin");
  return {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
  };
}

function runShellCommand(command, { cwd, env, step }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const shell =
      process.platform === "win32"
        ? process.env.ComSpec || "cmd.exe"
        : "sh";
    const shellArgs =
      process.platform === "win32"
        ? ["/d", "/s", "/c", command]
        : ["-lc", command];

    emit("verify.step.start", { step, command });

    const child = spawn(shell, shellArgs, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => process.stderr.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));

    child.on("error", (error) => {
      emit("verify.step.finish", {
        step,
        ok: false,
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        error: error.message,
      });
      resolve(1);
    });

    child.on("close", (code, signal) => {
      emit("verify.step.finish", {
        step,
        ok: code === 0,
        exitCode: code ?? 1,
        durationMs: Date.now() - startedAt,
        signal: signal ?? null,
      });
      resolve(code ?? 1);
    });
  });
}

async function main() {
  const steps = parseSteps(process.argv.slice(2));
  const pkg = await readPackageJson(ROOT);
  const scripts = pkg.scripts ?? {};
  const env = buildScriptEnv(ROOT);
  const binDir = path.join(ROOT, "node_modules", ".bin");

  try {
    await access(binDir, constants.R_OK);
  } catch {
    emit("verify.config_error", {
      ok: false,
      message:
        "node_modules/.bin is missing. Install dependencies before running verification.",
      expectedPath: binDir,
    });
    process.exit(2);
  }

  const missingScripts = steps.filter(
    (step) =>
      !(step in DIRECT_STEP_COMMANDS) && typeof scripts[step] !== "string",
  );
  if (missingScripts.length > 0) {
    emit("verify.config_error", {
      ok: false,
      message: `Missing package.json scripts: ${missingScripts.join(", ")}`,
    });
    process.exit(2);
  }

  emit("verify.start", {
    ok: true,
    root: ROOT,
    steps,
    pathIncludesNodeModulesBin: true,
  });

  // Run queue consumer check as a pre-step before test
  if (steps.includes("test")) {
    const checkScript = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "check-queue-consumers.mjs",
    );
    emit("verify.step.start", { step: "queue-consumers", command: `node ${checkScript}` });
    const startedAt = Date.now();
    const check = spawnSync(process.execPath, [checkScript], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const checkOk = check.status === 0;
    emit("verify.step.finish", {
      step: "queue-consumers",
      ok: checkOk,
      exitCode: check.status ?? 1,
      durationMs: Date.now() - startedAt,
    });
    if (!checkOk) {
      process.stderr.write(check.stdout);
      process.stderr.write(check.stderr);
      emit("verify.summary", {
        ok: false,
        results: [{ step: "queue-consumers", exitCode: check.status ?? 1 }],
      });
      process.exit(1);
    }
    // Log the check output to stderr for visibility
    process.stderr.write(check.stdout);
  }

  const results = [];
  for (const step of steps) {
    const command = DIRECT_STEP_COMMANDS[step] ?? scripts[step];
    const exitCode = await runShellCommand(command, {
      cwd: ROOT,
      env,
      step,
    });

    results.push({ step, exitCode });

    if (exitCode !== 0) {
      emit("verify.summary", {
        ok: false,
        results,
      });
      process.exit(exitCode);
    }
  }

  emit("verify.summary", {
    ok: true,
    results,
  });
}

main().catch((error) => {
  emit("verify.fatal", {
    ok: false,
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
