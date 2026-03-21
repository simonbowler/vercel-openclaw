import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildDynamicRestoreFiles,
  buildRestoreAssetManifest,
  buildStaticRestoreFiles,
  OPENCLAW_RESTORE_ASSET_MANIFEST_PATH,
} from "@/server/openclaw/restore-assets";
import {
  OPENCLAW_CONFIG_PATH,
  OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
  OPENCLAW_STARTUP_SCRIPT_PATH,
  OPENCLAW_STATE_DIR,
} from "@/server/openclaw/config";

// --- buildRestoreAssetManifest ---

test("buildRestoreAssetManifest returns stable sha256 across calls", () => {
  const first = buildRestoreAssetManifest();
  const second = buildRestoreAssetManifest();

  assert.deepStrictEqual(first, second);
  assert.equal(first.version, 1);
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
});

test("buildRestoreAssetManifest staticPaths matches buildStaticRestoreFiles paths", () => {
  const manifest = buildRestoreAssetManifest();
  const staticFiles = buildStaticRestoreFiles();

  assert.deepStrictEqual(
    manifest.staticPaths,
    staticFiles.map((f) => f.path),
  );
});

// --- buildStaticRestoreFiles ---

test("static restore files include startup and force-pair scripts", () => {
  const paths = buildStaticRestoreFiles().map((f) => f.path);

  assert.ok(paths.includes(OPENCLAW_STARTUP_SCRIPT_PATH));
  assert.ok(paths.includes(OPENCLAW_FORCE_PAIR_SCRIPT_PATH));
});

test("static restore files produce non-empty buffers", () => {
  for (const file of buildStaticRestoreFiles()) {
    assert.ok(Buffer.isBuffer(file.content), `${file.path} content is a Buffer`);
    assert.ok(file.content.length > 0, `${file.path} content is non-empty`);
  }
});

// --- buildDynamicRestoreFiles ---

test("dynamic restore files only contain openclaw.json with the provided origin", () => {
  const files = buildDynamicRestoreFiles({
    proxyOrigin: "https://example.test",
    apiKey: "token-123",
  });

  assert.equal(files.length, 1);
  assert.equal(files[0]!.path, OPENCLAW_CONFIG_PATH);

  const content = files[0]!.content.toString("utf8");
  assert.ok(content.includes("https://example.test"));
});

test("dynamic restore files work without apiKey", () => {
  const files = buildDynamicRestoreFiles({
    proxyOrigin: "https://no-key.test",
  });

  assert.equal(files.length, 1);
  assert.equal(files[0]!.path, OPENCLAW_CONFIG_PATH);
});

test("dynamic restore files include telegram webhookSecret in openclaw config", () => {
  const files = buildDynamicRestoreFiles({
    proxyOrigin: "https://telegram.test",
    telegramBotToken: "telegram-bot-token",
    telegramWebhookSecret: "telegram-webhook-secret",
  });

  const configFile = files.find((file) => file.path === OPENCLAW_CONFIG_PATH);
  assert.ok(configFile, "Expected dynamic restore files to include openclaw config");

  const config = JSON.parse(configFile.content.toString("utf8")) as {
    channels?: {
      telegram?: {
        webhookSecret?: string;
      };
    };
  };

  assert.equal(
    config.channels?.telegram?.webhookSecret,
    "telegram-webhook-secret",
  );
});

// --- manifest path ---

test("manifest path is under the openclaw state directory", () => {
  assert.ok(
    OPENCLAW_RESTORE_ASSET_MANIFEST_PATH.startsWith(OPENCLAW_STATE_DIR),
    `Expected ${OPENCLAW_RESTORE_ASSET_MANIFEST_PATH} to start with ${OPENCLAW_STATE_DIR}`,
  );
  assert.ok(OPENCLAW_RESTORE_ASSET_MANIFEST_PATH.endsWith(".json"));
});
