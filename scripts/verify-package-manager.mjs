#!/usr/bin/env node
/**
 * Regression guard: fail if any pnpm signal reappears in the repo.
 *
 * Checks:
 *   1. No pnpm-lock.yaml or pnpm-workspace.yaml at repo root
 *   2. package.json#packageManager starts with "npm@"
 *   3. No scripts in package.json reference pnpm
 *   4. No pnpm references in scanned text files (excluding package-lock.json,
 *      this script, build artifacts, and the firewall domain-categorisation regex)
 */
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

const disallowedRootFiles = ["pnpm-lock.yaml", "pnpm-workspace.yaml"];

const scanRoots = [
  "package.json",
  "vercel.json",
  "README.md",
  "CLAUDE.md",
  ".github/workflows",
  "scripts",
];

const textExtensions = new Set([
  ".md",
  ".json",
  ".js",
  ".cjs",
  ".mjs",
  ".ts",
  ".tsx",
  ".sh",
  ".yml",
  ".yaml",
]);

const skipDirs = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "coverage",
  ".turbo",
]);

function collectFiles(absolutePath, out) {
  if (!fs.existsSync(absolutePath)) return;
  const stat = fs.statSync(absolutePath);
  if (stat.isFile()) {
    out.push(absolutePath);
    return;
  }
  for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    collectFiles(path.join(absolutePath, entry.name), out);
  }
}

function shouldScan(absolutePath) {
  const base = path.basename(absolutePath);
  if (base === "package-lock.json") return false;
  if (base === "verify-package-manager.mjs") return false;
  if (base === "audit-verifier-surface.mjs") return false;
  if (base === "check-verifier-contract.mjs") return false;
  return textExtensions.has(path.extname(base)) || base === "Dockerfile";
}

// ── 1. Disallowed root files ──────────────────────────────────────────
const rootFileOffenders = disallowedRootFiles.filter((name) =>
  fs.existsSync(path.join(repoRoot, name)),
);

// ── 2. package.json checks ────────────────────────────────────────────
const pkgPath = path.join(repoRoot, "package.json");
if (!fs.existsSync(pkgPath)) {
  console.error("package-manager verification failed");
  console.error("- package.json is missing");
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const packageJsonIssues = [];

if (
  typeof pkg.packageManager !== "string" ||
  !pkg.packageManager.startsWith("npm@")
) {
  packageJsonIssues.push(
    `package.json: packageManager must start with npm@ (received ${JSON.stringify(pkg.packageManager ?? null)})`,
  );
}

for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
  if (typeof command === "string" && /\bpnpm\b/.test(command)) {
    packageJsonIssues.push(
      `package.json:scripts.${name} contains pnpm -> ${command}`,
    );
  }
}

// ── 3. Text-file scan ─────────────────────────────────────────────────
const filesToScan = [];
for (const relPath of scanRoots) {
  collectFiles(path.join(repoRoot, relPath), filesToScan);
}

const textOffenders = [];
for (const absolutePath of filesToScan) {
  if (!shouldScan(absolutePath)) continue;
  const relativePath = path.relative(repoRoot, absolutePath);
  const text = fs.readFileSync(absolutePath, "utf8");
  if (/\bpnpm\b/.test(text)) {
    textOffenders.push(relativePath);
  }
}

// ── Report ────────────────────────────────────────────────────────────
if (
  rootFileOffenders.length ||
  packageJsonIssues.length ||
  textOffenders.length
) {
  console.error("package-manager verification failed");

  if (rootFileOffenders.length) {
    console.error("\nDisallowed root files:");
    for (const file of rootFileOffenders) console.error(`  - ${file}`);
  }
  if (packageJsonIssues.length) {
    console.error("\npackage.json issues:");
    for (const issue of packageJsonIssues) console.error(`  - ${issue}`);
  }
  if (textOffenders.length) {
    console.error("\nRemaining pnpm references:");
    for (const file of textOffenders) console.error(`  - ${file}`);
  }

  process.exit(1);
}

console.log("package-manager verification passed");
