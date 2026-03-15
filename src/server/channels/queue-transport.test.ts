import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

type Trigger = {
  type: string;
  topic: string;
};

type FunctionConfig = {
  maxDuration?: number | "max";
  experimentalTriggers?: Trigger[];
};

type VercelConfig = {
  functions?: Record<string, FunctionConfig>;
};

const PROJECT_ROOT = process.cwd();
const QUEUE_ROUTES_DIR = path.join(
  PROJECT_ROOT,
  "src",
  "app",
  "api",
  "queues",
);

async function walkRouteFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await walkRouteFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && entry.name === "route.ts") {
      files.push(fullPath);
    }
  }

  return files;
}

function toRepoPath(filePath: string): string {
  return path.relative(PROJECT_ROOT, filePath).replaceAll(path.sep, "/");
}

function toRoutePath(filePath: string): string {
  const repoPath = toRepoPath(filePath);
  return (
    "/" + repoPath.replace(/^src\/app\//, "").replace(/\/route\.ts$/, "")
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("queue consumer routes are configured in vercel.json and do not export maxDuration", async () => {
  await stat(QUEUE_ROUTES_DIR).catch(() => {
    assert.fail("Missing src/app/api/queues directory");
  });

  const routeFiles = await walkRouteFiles(QUEUE_ROUTES_DIR);
  assert.ok(
    routeFiles.length > 0,
    "Expected at least one queue consumer route",
  );

  const vercelConfig = JSON.parse(
    await readFile(path.join(PROJECT_ROOT, "vercel.json"), "utf8"),
  ) as VercelConfig;

  for (const routeFile of routeFiles) {
    const repoPath = toRepoPath(routeFile);
    const source = await readFile(routeFile, "utf8");

    assert.ok(
      !source.includes("export const maxDuration"),
      `${repoPath} should not export maxDuration; set it in vercel.json instead`,
    );

    const fnConfig = vercelConfig.functions?.[repoPath];
    assert.ok(
      fnConfig,
      `Missing vercel.json.functions entry for ${repoPath}`,
    );
    assert.equal(
      fnConfig?.maxDuration,
      300,
      `${repoPath} should set maxDuration to 300`,
    );
    assert.ok(
      Array.isArray(fnConfig?.experimentalTriggers) &&
        fnConfig.experimentalTriggers.length > 0,
      `${repoPath} is missing experimentalTriggers`,
    );
  }
});

test("README and CLAUDE document every queue consumer route", async () => {
  const routeFiles = await walkRouteFiles(QUEUE_ROUTES_DIR);
  const readme = await readFile(path.join(PROJECT_ROOT, "README.md"), "utf8");
  const claude = await readFile(path.join(PROJECT_ROOT, "CLAUDE.md"), "utf8");

  assert.match(readme, /Vercel Queues/i, "README.md should mention Vercel Queues");
  assert.match(claude, /Vercel Queues/i, "CLAUDE.md should mention Vercel Queues");

  for (const routeFile of routeFiles) {
    const routePath = toRoutePath(routeFile);
    const pattern = new RegExp(escapeRegExp(routePath));
    assert.match(readme, pattern, `README.md is missing ${routePath}`);
    assert.match(claude, pattern, `CLAUDE.md is missing ${routePath}`);
  }
});
