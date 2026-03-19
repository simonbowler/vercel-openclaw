import { createHash } from "node:crypto";

import {
  buildFastRestoreScript,
  buildForcePairScript,
  buildGatewayConfig,
  buildImageGenScript,
  buildImageGenSkill,
  buildStartupScript,
  buildStructuredExtractScript,
  buildStructuredExtractSkill,
  buildTtsScript,
  buildTtsSkill,
  buildVisionScript,
  buildVisionSkill,
  buildWebSearchScript,
  buildWebSearchSkill,
  OPENCLAW_BUILTIN_IMAGE_GEN_SCRIPT_PATH,
  OPENCLAW_BUILTIN_IMAGE_GEN_SKILL_PATH,
  OPENCLAW_CONFIG_PATH,
  OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
  OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
  OPENCLAW_IMAGE_GEN_SCRIPT_PATH,
  OPENCLAW_IMAGE_GEN_SKILL_PATH,
  OPENCLAW_STARTUP_SCRIPT_PATH,
  OPENCLAW_STATE_DIR,
  OPENCLAW_TELEGRAM_BOT_TOKEN_PATH,
  OPENCLAW_STRUCTURED_EXTRACT_SCRIPT_PATH,
  OPENCLAW_STRUCTURED_EXTRACT_SKILL_PATH,
  OPENCLAW_TTS_SCRIPT_PATH,
  OPENCLAW_TTS_SKILL_PATH,
  OPENCLAW_VISION_SCRIPT_PATH,
  OPENCLAW_VISION_SKILL_PATH,
  OPENCLAW_WEB_SEARCH_SCRIPT_PATH,
  OPENCLAW_WEB_SEARCH_SKILL_PATH,
} from "@/server/openclaw/config";

export const OPENCLAW_RESTORE_ASSET_MANIFEST_PATH =
  `${OPENCLAW_STATE_DIR}/.restore-assets-manifest.json`;

export type RestoreAssetManifest = {
  version: 1;
  sha256: string;
  staticPaths: string[];
};

export function buildStaticRestoreFiles(): { path: string; content: Buffer }[] {
  return [
    { path: OPENCLAW_FORCE_PAIR_SCRIPT_PATH, content: Buffer.from(buildForcePairScript()) },
    { path: OPENCLAW_STARTUP_SCRIPT_PATH, content: Buffer.from(buildStartupScript()) },
    { path: OPENCLAW_FAST_RESTORE_SCRIPT_PATH, content: Buffer.from(buildFastRestoreScript()) },
    { path: OPENCLAW_IMAGE_GEN_SKILL_PATH, content: Buffer.from(buildImageGenSkill()) },
    { path: OPENCLAW_IMAGE_GEN_SCRIPT_PATH, content: Buffer.from(buildImageGenScript()) },
    { path: OPENCLAW_BUILTIN_IMAGE_GEN_SKILL_PATH, content: Buffer.from(buildImageGenSkill()) },
    { path: OPENCLAW_BUILTIN_IMAGE_GEN_SCRIPT_PATH, content: Buffer.from(buildImageGenScript()) },
    { path: OPENCLAW_WEB_SEARCH_SKILL_PATH, content: Buffer.from(buildWebSearchSkill()) },
    { path: OPENCLAW_WEB_SEARCH_SCRIPT_PATH, content: Buffer.from(buildWebSearchScript()) },
    { path: OPENCLAW_VISION_SKILL_PATH, content: Buffer.from(buildVisionSkill()) },
    { path: OPENCLAW_VISION_SCRIPT_PATH, content: Buffer.from(buildVisionScript()) },
    { path: OPENCLAW_TTS_SKILL_PATH, content: Buffer.from(buildTtsSkill()) },
    { path: OPENCLAW_TTS_SCRIPT_PATH, content: Buffer.from(buildTtsScript()) },
    {
      path: OPENCLAW_STRUCTURED_EXTRACT_SKILL_PATH,
      content: Buffer.from(buildStructuredExtractSkill()),
    },
    {
      path: OPENCLAW_STRUCTURED_EXTRACT_SCRIPT_PATH,
      content: Buffer.from(buildStructuredExtractScript()),
    },
  ];
}

export function buildDynamicRestoreFiles(options: {
  proxyOrigin: string;
  apiKey?: string;
  telegramBotToken?: string;
  slackCredentials?: { botToken: string; signingSecret: string };
}): { path: string; content: Buffer }[] {
  const files: { path: string; content: Buffer }[] = [
    {
      path: OPENCLAW_CONFIG_PATH,
      content: Buffer.from(
        buildGatewayConfig(
          options.apiKey,
          options.proxyOrigin,
          options.telegramBotToken,
          options.slackCredentials,
        ),
      ),
    },
  ];

  if (options.telegramBotToken) {
    files.push({
      path: OPENCLAW_TELEGRAM_BOT_TOKEN_PATH,
      content: Buffer.from(options.telegramBotToken),
    });
  }

  return files;
}

export function buildRestoreAssetManifest(): RestoreAssetManifest {
  const staticFiles = buildStaticRestoreFiles();
  const hash = createHash("sha256");

  for (const file of staticFiles) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }

  return {
    version: 1,
    sha256: hash.digest("hex"),
    staticPaths: staticFiles.map((file) => file.path),
  };
}
