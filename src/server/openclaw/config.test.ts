import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildGatewayConfig,
  buildGatewayRestartScript,
  computeGatewayConfigHash,
  toWhatsAppGatewayConfig,
  GATEWAY_CONFIG_HASH_VERSION,
  buildStartupScript,
  buildWebSearchSkill,
  buildWebSearchScript,
  buildVisionSkill,
  buildVisionScript,
  buildTtsSkill,
  buildTtsScript,
  buildStructuredExtractSkill,
  buildStructuredExtractScript,
  buildEmbeddingsSkill,
  buildEmbeddingsScript,
  buildSemanticSearchSkill,
  buildSemanticSearchScript,
  buildTranscriptionSkill,
  buildTranscriptionScript,
  buildReasoningSkill,
  buildReasoningScript,
  buildCompareSkill,
  buildCompareScript,
  OPENCLAW_TELEGRAM_WEBHOOK_HOST,
  OPENCLAW_TELEGRAM_INTERNAL_WEBHOOK_PATH,
  TELEGRAM_PUBLIC_WEBHOOK_PATH,
} from "@/server/openclaw/config";

function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    originals[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }

  try {
    return fn();
  } finally {
    for (const key of Object.keys(originals)) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
  }
}

test("buildGatewayConfig disables insecure auth by default but always disables device auth", () => {
  withEnv(
    {
      OPENCLAW_ALLOW_INSECURE_AUTH: undefined,
    },
    () => {
      const config = JSON.parse(buildGatewayConfig()) as {
        gateway: {
          controlUi: {
            allowInsecureAuth: boolean;
            dangerouslyDisableDeviceAuth: boolean;
          };
        };
      };

      assert.equal(config.gateway.controlUi.allowInsecureAuth, false);
      assert.equal(config.gateway.controlUi.dangerouslyDisableDeviceAuth, true);
    },
  );
});

test("buildGatewayConfig reads insecure auth toggle from env", () => {
  withEnv(
    {
      OPENCLAW_ALLOW_INSECURE_AUTH: "yes",
    },
    () => {
      const config = JSON.parse(buildGatewayConfig()) as {
        gateway: {
          controlUi: {
            allowInsecureAuth: boolean;
            dangerouslyDisableDeviceAuth: boolean;
          };
        };
      };

      assert.equal(config.gateway.controlUi.allowInsecureAuth, true);
      assert.equal(config.gateway.controlUi.dangerouslyDisableDeviceAuth, true);
    },
  );
});

test("buildGatewayConfig throws for invalid boolean env values", () => {
  withEnv(
    {
      OPENCLAW_ALLOW_INSECURE_AUTH: "maybe",
      OPENCLAW_DANGEROUSLY_DISABLE_DEVICE_AUTH: undefined,
    },
    () => {
      assert.throws(
        () => buildGatewayConfig(),
        /OPENCLAW_ALLOW_INSECURE_AUTH must be one of: true, false, 1, 0, yes, no, on, off\./,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// buildGatewayConfig — model aliases and providers
// ---------------------------------------------------------------------------

test("buildGatewayConfig with apiKey includes model aliases and providers", () => {
  const config = JSON.parse(buildGatewayConfig("test-key")) as Record<string, unknown>;

  // Model aliases
  const agents = config.agents as { defaults: { models: Record<string, unknown> } };
  assert.ok(agents.defaults.models["vercel-ai-gateway/openai/gpt-5.3-chat"]);
  assert.ok(agents.defaults.models["vercel-ai-gateway/google/gemini-3.1-flash-image-preview"]);

  // Provider models
  const models = config.models as { providers: { openai: { models: { id: string }[] } } };
  const modelIds = models.providers.openai.models.map((m) => m.id);
  assert.ok(modelIds.includes("gpt-image-1"));
  assert.ok(modelIds.includes("dall-e-3"));
  assert.ok(modelIds.includes("gpt-4o"));
  assert.ok(modelIds.includes("gpt-4o-mini-tts"));
  assert.ok(modelIds.includes("text-embedding-3-small"));
  assert.ok(modelIds.includes("text-embedding-3-large"));
  assert.ok(modelIds.includes("whisper-1"));

  // Media tools
  const tools = config.tools as { media: { audio: { enabled: boolean } } };
  assert.equal(tools.media.audio.enabled, true);
});

test("buildGatewayConfig omits telegram webhookUrl when proxy origin is missing", () => {
  const withoutOrigin = JSON.parse(
    buildGatewayConfig(undefined, undefined, "test-telegram-token"),
  ) as {
    channels: {
      telegram: Record<string, unknown>;
    };
  };
  assert.equal(
    Object.prototype.hasOwnProperty.call(withoutOrigin.channels.telegram, "webhookUrl"),
    false,
  );

  const withOrigin = JSON.parse(
    buildGatewayConfig(undefined, "https://app.example.com/", "test-telegram-token"),
  ) as {
    channels: {
      telegram: {
        webhookHost: string;
        webhookPath: string;
        webhookUrl?: string;
      };
    };
  };
  assert.equal(withOrigin.channels.telegram.webhookHost, OPENCLAW_TELEGRAM_WEBHOOK_HOST);
  assert.equal(
    withOrigin.channels.telegram.webhookPath,
    OPENCLAW_TELEGRAM_INTERNAL_WEBHOOK_PATH,
  );
  assert.equal(
    withOrigin.channels.telegram.webhookUrl,
    `https://app.example.com${TELEGRAM_PUBLIC_WEBHOOK_PATH}`,
  );
});

// ---------------------------------------------------------------------------
// Skill builders — content assertions
// ---------------------------------------------------------------------------

test("buildWebSearchSkill returns valid skill metadata", () => {
  const skill = buildWebSearchSkill();
  assert.ok(skill.includes("name: web-search"));
  assert.ok(skill.includes("AI_GATEWAY_API_KEY"));
});

test("buildWebSearchScript references web_search and chat completions", () => {
  const script = buildWebSearchScript();
  assert.ok(script.includes("web_search"));
  assert.ok(script.includes("/v1/chat/completions"));
});

test("buildVisionSkill returns valid skill metadata", () => {
  const skill = buildVisionSkill();
  assert.ok(skill.includes("name: vision"));
  assert.ok(skill.includes("AI_GATEWAY_API_KEY"));
});

test("buildVisionScript references image_url and chat completions", () => {
  const script = buildVisionScript();
  assert.ok(script.includes("image_url"));
  assert.ok(script.includes("/v1/chat/completions"));
});

test("buildTtsSkill returns valid skill metadata", () => {
  const skill = buildTtsSkill();
  assert.ok(skill.includes("name: tts"));
  assert.ok(skill.includes("AI_GATEWAY_API_KEY"));
});

test("buildTtsScript uses AI Gateway and outputs MEDIA line", () => {
  const script = buildTtsScript();
  assert.ok(script.includes("ai-gateway.vercel.sh/v1/audio/speech"));
  assert.ok(script.includes("MEDIA:"));
});

test("buildStructuredExtractSkill returns valid skill metadata", () => {
  const skill = buildStructuredExtractSkill();
  assert.ok(skill.includes("name: structured-extract"));
  assert.ok(skill.includes("AI_GATEWAY_API_KEY"));
});

test("buildStructuredExtractScript uses json_schema response format", () => {
  const script = buildStructuredExtractScript();
  assert.ok(script.includes("json_schema"));
  assert.ok(script.includes("response_format"));
});

// ---------------------------------------------------------------------------
// Gateway restart script
// ---------------------------------------------------------------------------

test("buildGatewayRestartScript exits non-zero when gateway token is empty", () => {
  const script = buildGatewayRestartScript();
  assert.ok(script.includes("set -euo pipefail"), "restart script should use strict mode");
  assert.ok(script.includes("exit 1"), "restart script should exit 1 on empty token");
  assert.ok(
    script.includes("empty_gateway_token"),
    "restart script should emit structured error for empty token",
  );
});

test("buildGatewayRestartScript does not touch pairing state", () => {
  const script = buildGatewayRestartScript();
  assert.ok(!script.includes("paired.json"), "restart script must not reference paired.json");
  assert.ok(!script.includes("pending.json"), "restart script must not reference pending.json");
  assert.ok(!script.includes("devices"), "restart script must not reference devices dir");
});

test("buildGatewayRestartScript does not install shell hooks", () => {
  const script = buildGatewayRestartScript();
  assert.ok(!script.includes("shell-commands-for-learning"), "restart script must not install learning hooks");
  assert.ok(!script.includes(".zshrc"), "restart script must not modify .zshrc");
  assert.ok(!script.includes(".bashrc"), "restart script must not modify .bashrc");
});

test("buildGatewayRestartScript kills existing gateway and launches a new one", () => {
  const script = buildGatewayRestartScript();
  assert.ok(script.includes('pkill -f "openclaw.gateway"'), "restart script should kill existing gateway");
  assert.ok(script.includes("openclaw gateway"), "restart script should launch the gateway");
});

test("buildStartupScript and buildGatewayRestartScript share the same gateway launch command", () => {
  const startup = buildStartupScript();
  const restart = buildGatewayRestartScript();

  // Both should use setsid to launch the gateway in the background
  assert.ok(startup.includes("setsid"), "startup script should use setsid launch");
  assert.ok(restart.includes("setsid"), "restart script should use setsid launch");

  // Both should read the gateway token from disk
  assert.ok(startup.includes(".gateway-token"), "startup should read gateway token");
  assert.ok(restart.includes(".gateway-token"), "restart should read gateway token");
});

test("buildStartupScript clears pairing state while restart does not", () => {
  const startup = buildStartupScript();
  const restart = buildGatewayRestartScript();

  assert.ok(startup.includes("paired.json"), "startup should clear paired.json");
  assert.ok(!restart.includes("paired.json"), "restart must not clear paired.json");
});

test("computeGatewayConfigHash returns a stable sha256 hex digest", () => {
  const hash = computeGatewayConfigHash({});

  assert.match(hash, /^[a-f0-9]{64}$/);
});

test("computeGatewayConfigHash returns the same hash for identical inputs", () => {
  const input = {
    telegramBotToken: "telegram-token",
    telegramWebhookSecret: "telegram-secret",
    slackCredentials: {
      botToken: "xoxb-test",
      signingSecret: "slack-secret",
    },
  };

  assert.equal(computeGatewayConfigHash(input), computeGatewayConfigHash(input));
});

test("computeGatewayConfigHash stays stable when buildGatewayConfig output varies by origin or api key", () => {
  const configA = buildGatewayConfig(
    "api-key-a",
    "https://app-a.example.com",
    "telegram-token",
    { botToken: "xoxb-test", signingSecret: "slack-secret" },
    "telegram-secret",
  );
  const configB = buildGatewayConfig(
    "api-key-b",
    "https://app-b.example.com",
    "telegram-token",
    { botToken: "xoxb-test", signingSecret: "slack-secret" },
    "telegram-secret",
  );

  assert.notEqual(configA, configB);
  assert.equal(
    computeGatewayConfigHash({
      telegramBotToken: "telegram-token",
      telegramWebhookSecret: "telegram-secret",
      slackCredentials: {
        botToken: "xoxb-test",
        signingSecret: "slack-secret",
      },
    }),
    computeGatewayConfigHash({
      telegramBotToken: "telegram-token",
      telegramWebhookSecret: "telegram-secret",
      slackCredentials: {
        botToken: "xoxb-test",
        signingSecret: "slack-secret",
      },
    }),
  );
});

test("computeGatewayConfigHash changes when telegram bot token changes", () => {
  const baseline = computeGatewayConfigHash({
    telegramBotToken: "telegram-token-a",
  });
  const changed = computeGatewayConfigHash({
    telegramBotToken: "telegram-token-b",
  });

  assert.notEqual(baseline, changed);
});

test("computeGatewayConfigHash changes when telegram webhook secret changes", () => {
  const baseline = computeGatewayConfigHash({
    telegramBotToken: "telegram-token",
    telegramWebhookSecret: "secret-a",
  });
  const changed = computeGatewayConfigHash({
    telegramBotToken: "telegram-token",
    telegramWebhookSecret: "secret-b",
  });

  assert.notEqual(baseline, changed);
});

test("computeGatewayConfigHash changes when slack bot token changes", () => {
  const baseline = computeGatewayConfigHash({
    slackCredentials: {
      botToken: "xoxb-a",
      signingSecret: "slack-secret",
    },
  });
  const changed = computeGatewayConfigHash({
    slackCredentials: {
      botToken: "xoxb-b",
      signingSecret: "slack-secret",
    },
  });

  assert.notEqual(baseline, changed);
});

test("computeGatewayConfigHash is deterministic for identical input", () => {
  const input = {
    telegramBotToken: "telegram-token",
    telegramWebhookSecret: "telegram-secret",
    slackCredentials: {
      botToken: "slack-bot-token",
      signingSecret: "slack-signing-secret",
    },
  };

  assert.equal(computeGatewayConfigHash(input), computeGatewayConfigHash(input));
});

test("computeGatewayConfigHash changes when channel config changes", () => {
  const base = computeGatewayConfigHash({});
  const telegram = computeGatewayConfigHash({
    telegramBotToken: "telegram-token",
    telegramWebhookSecret: "telegram-secret",
  });
  const slack = computeGatewayConfigHash({
    slackCredentials: {
      botToken: "slack-bot-token",
      signingSecret: "slack-signing-secret",
    },
  });

  assert.notEqual(base, telegram);
  assert.notEqual(base, slack);
  assert.notEqual(telegram, slack);
});

test("computeGatewayConfigHash changes when slack signing secret changes and uses the current version", () => {
  const baseline = computeGatewayConfigHash({
    slackCredentials: {
      botToken: "xoxb-test",
      signingSecret: "secret-a",
    },
  });
  const changed = computeGatewayConfigHash({
    slackCredentials: {
      botToken: "xoxb-test",
      signingSecret: "secret-b",
    },
  });

  assert.equal(GATEWAY_CONFIG_HASH_VERSION, 1);
  assert.notEqual(baseline, changed);
});

// ---------------------------------------------------------------------------
// buildGatewayConfig — WhatsApp gateway-native channel
// ---------------------------------------------------------------------------

test("buildGatewayConfig includes whatsapp policy config when enabled", () => {
  const config = JSON.parse(
    buildGatewayConfig(undefined, undefined, undefined, undefined, undefined, {
      enabled: true,
      dmPolicy: "open",
      allowFrom: ["*"],
      groupPolicy: "allowlist",
      groupAllowFrom: ["+1234567890"],
      groups: ["group-1"],
    }),
  ) as { channels?: { whatsapp?: Record<string, unknown> } };

  assert.ok(config.channels?.whatsapp, "whatsapp channel should be present");
  assert.equal(config.channels!.whatsapp!.enabled, true);
  assert.equal(config.channels!.whatsapp!.dmPolicy, "open");
  assert.deepEqual(config.channels!.whatsapp!.allowFrom, ["*"]);
  assert.equal(config.channels!.whatsapp!.groupPolicy, "allowlist");
  assert.deepEqual(config.channels!.whatsapp!.groupAllowFrom, ["+1234567890"]);
  assert.deepEqual(config.channels!.whatsapp!.groups, ["group-1"]);
});

test("buildGatewayConfig uses default whatsapp policies when only enabled is set", () => {
  const config = JSON.parse(
    buildGatewayConfig(undefined, undefined, undefined, undefined, undefined, {
      enabled: true,
    }),
  ) as { channels?: { whatsapp?: Record<string, unknown> } };

  assert.ok(config.channels?.whatsapp);
  assert.equal(config.channels!.whatsapp!.dmPolicy, "pairing");
  assert.deepEqual(config.channels!.whatsapp!.allowFrom, []);
  assert.equal(config.channels!.whatsapp!.groupPolicy, "allowlist");
});

test("buildGatewayConfig omits whatsapp when not enabled", () => {
  const config = JSON.parse(
    buildGatewayConfig(undefined, undefined, undefined, undefined, undefined, {
      enabled: false,
    }),
  ) as { channels?: { whatsapp?: unknown } };

  assert.equal(config.channels?.whatsapp, undefined);
});

test("buildGatewayConfig omits whatsapp when config is undefined", () => {
  const config = JSON.parse(
    buildGatewayConfig(),
  ) as { channels?: { whatsapp?: unknown } };

  assert.equal(config.channels?.whatsapp, undefined);
});

test("buildGatewayConfig omits whatsapp groups key when groups is not provided", () => {
  const config = JSON.parse(
    buildGatewayConfig(undefined, undefined, undefined, undefined, undefined, {
      enabled: true,
    }),
  ) as { channels?: { whatsapp?: Record<string, unknown> } };

  assert.equal(
    Object.prototype.hasOwnProperty.call(config.channels!.whatsapp!, "groups"),
    false,
    "groups key should not be present when undefined",
  );
});

test("buildGatewayConfig includes whatsapp alongside telegram and slack", () => {
  const config = JSON.parse(
    buildGatewayConfig(
      "api-key",
      "https://app.example.com",
      "telegram-token",
      { botToken: "xoxb-test", signingSecret: "slack-secret" },
      "telegram-secret",
      { enabled: true, dmPolicy: "pairing" },
    ),
  ) as { channels?: Record<string, unknown> };

  assert.ok(config.channels?.telegram, "telegram should be present");
  assert.ok(config.channels?.slack, "slack should be present");
  assert.ok(config.channels?.whatsapp, "whatsapp should be present");
});

// ---------------------------------------------------------------------------
// computeGatewayConfigHash — WhatsApp
// ---------------------------------------------------------------------------

test("computeGatewayConfigHash changes when whatsapp config is added", () => {
  const baseline = computeGatewayConfigHash({});
  const withWhatsApp = computeGatewayConfigHash({
    whatsappConfig: { enabled: true, dmPolicy: "open" },
  });

  assert.notEqual(baseline, withWhatsApp);
});

test("computeGatewayConfigHash changes when whatsapp policy changes", () => {
  const a = computeGatewayConfigHash({
    whatsappConfig: { enabled: true, dmPolicy: "pairing" },
  });
  const b = computeGatewayConfigHash({
    whatsappConfig: { enabled: true, dmPolicy: "open" },
  });

  assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// toWhatsAppGatewayConfig helper
// ---------------------------------------------------------------------------

test("toWhatsAppGatewayConfig returns undefined for null input", () => {
  assert.equal(toWhatsAppGatewayConfig(null), undefined);
});

test("toWhatsAppGatewayConfig returns undefined when not enabled", () => {
  assert.equal(
    toWhatsAppGatewayConfig({ enabled: false }),
    undefined,
  );
});

test("toWhatsAppGatewayConfig extracts gateway-relevant fields", () => {
  const result = toWhatsAppGatewayConfig({
    enabled: true,
    dmPolicy: "open",
    allowFrom: ["*"],
    groupPolicy: "allowlist",
    groupAllowFrom: ["+1"],
    groups: ["g1"],
  });

  assert.deepEqual(result, {
    enabled: true,
    dmPolicy: "open",
    allowFrom: ["*"],
    groupPolicy: "allowlist",
    groupAllowFrom: ["+1"],
    groups: ["g1"],
  });
});

// --- Embeddings skill ---

test("buildEmbeddingsSkill returns valid skill metadata", () => {
  const skill = buildEmbeddingsSkill();
  assert.ok(skill.includes("name: embeddings"));
  assert.ok(skill.includes("AI_GATEWAY_API_KEY"));
});

test("buildEmbeddingsScript uses /v1/embeddings", () => {
  const script = buildEmbeddingsScript();
  assert.ok(script.includes("/v1/embeddings"));
  assert.ok(script.includes("text-embedding-3-small"));
});

// --- Semantic Search skill ---

test("buildSemanticSearchSkill returns valid skill metadata", () => {
  const skill = buildSemanticSearchSkill();
  assert.ok(skill.includes("name: semantic-search"));
  assert.ok(skill.includes("AI_GATEWAY_API_KEY"));
});

test("buildSemanticSearchScript uses embeddings and cosine similarity", () => {
  const script = buildSemanticSearchScript();
  assert.ok(script.includes("/v1/embeddings"));
  assert.ok(script.includes("cosineSimilarity"));
  assert.ok(script.includes("schemaVersion: 1"));
  assert.ok(script.includes("queryDimensions = dimensions ?? index.dimensions ?? undefined"));
});

// --- Transcription skill ---

test("buildTranscriptionSkill returns valid skill metadata", () => {
  const skill = buildTranscriptionSkill();
  assert.ok(skill.includes("name: transcription"));
  assert.ok(skill.includes("AI_GATEWAY_API_KEY"));
});

test("buildTranscriptionScript uses /v1/audio/transcriptions and whisper-1", () => {
  const script = buildTranscriptionScript();
  assert.ok(script.includes("/v1/audio/transcriptions"));
  assert.ok(script.includes("whisper-1"));
  assert.ok(script.includes("FormData"));
});

// --- Reasoning skill ---

test("buildReasoningSkill returns valid skill metadata", () => {
  const skill = buildReasoningSkill();
  assert.ok(skill.includes("name: reasoning"));
  assert.ok(skill.includes("AI_GATEWAY_API_KEY"));
});

test("buildReasoningScript uses chat completions and reasoning effort", () => {
  const script = buildReasoningScript();
  assert.ok(script.includes("/v1/chat/completions"));
  assert.ok(script.includes("reasoning"));
  assert.ok(script.includes("effort"));
  assert.ok(script.includes("reasoning_summary"));
  assert.ok(script.includes("reasoning_details"));
  assert.ok(script.includes('"minimal"'));
  assert.ok(script.includes('"xhigh"'));
});

// ---------------------------------------------------------------------------
// Executable runtime regression tests
// ---------------------------------------------------------------------------

async function writeGeneratedFile(
  dir: string,
  name: string,
  content: string,
): Promise<string> {
  const filePath = join(dir, name);
  await writeFile(filePath, content, "utf8");
  return filePath;
}

function runNodeScript(
  args: string[],
  options: { cwd: string; env?: Record<string, string | undefined> },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

test("buildEmbeddingsScript rejects non-positive dimensions at runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-embeddings-"));
  try {
    const scriptPath = await writeGeneratedFile(
      dir,
      "embed.mjs",
      buildEmbeddingsScript(),
    );

    const result = runNodeScript(
      [scriptPath, "--text", "hello", "--dimensions", "0"],
      { cwd: dir, env: { AI_GATEWAY_API_KEY: "test-key" } },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--dimensions must be a positive integer/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("semantic-search index excludes db file on repeated runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-semantic-search-"));
  try {
    const scriptPath = await writeGeneratedFile(
      dir,
      "search.mjs",
      buildSemanticSearchScript(),
    );

    const preloadPath = await writeGeneratedFile(
      dir,
      "mock-fetch.mjs",
      `function fakeEmbedding(value) {
  const text = String(value);
  const sum = [...text].reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return [sum, text.length, sum % 97];
}

globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body ?? "{}"));
  const inputs = Array.isArray(body.input) ? body.input : [body.input];
  return new Response(
    JSON.stringify({
      data: inputs.map((input, index) => ({
        index,
        embedding: fakeEmbedding(input),
      })),
      model: body.model,
      usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};`,
    );

    const docsDir = join(dir, "docs");
    await mkdir(docsDir, { recursive: true });
    const alphaPath = join(docsDir, "alpha.txt");
    const betaPath = join(docsDir, "beta.txt");
    const dbPath = join(docsDir, ".semantic-index.json");

    await writeFile(alphaPath, "alpha document\n");
    await writeFile(betaPath, "beta document\n");

    for (let i = 0; i < 2; i += 1) {
      const run = runNodeScript(
        [
          "--import",
          preloadPath,
          scriptPath,
          "index",
          "--dir",
          docsDir,
          "--db",
          dbPath,
        ],
        { cwd: dir, env: { AI_GATEWAY_API_KEY: "test-key" } },
      );
      assert.equal(run.status, 0, run.stderr || run.stdout);
    }

    const index = JSON.parse(await readFile(dbPath, "utf8")) as {
      chunks: Array<{ path: string }>;
    };
    const indexedPaths = [
      ...new Set(index.chunks.map((chunk) => chunk.path)),
    ].sort();
    assert.deepEqual(indexedPaths, [alphaPath, betaPath].sort());
    assert.ok(
      index.chunks.every((chunk) => chunk.path !== dbPath),
      "semantic-search should never index its own db file",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("semantic-search query rejects dimensions that do not match the existing index", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-semantic-query-"));
  try {
    const scriptPath = await writeGeneratedFile(
      dir,
      "search.mjs",
      buildSemanticSearchScript(),
    );

    const dbPath = join(dir, "index.json");
    await writeFile(
      dbPath,
      JSON.stringify({
        schemaVersion: 1,
        createdAt: "2026-03-29T00:00:00.000Z",
        model: "openai/text-embedding-3-small",
        dimensions: 3,
        rootDir: null,
        chunks: [
          {
            id: "doc:0:4",
            path: "/tmp/doc.txt",
            start: 0,
            end: 4,
            text: "test",
            embedding: [1, 0, 0],
          },
        ],
      }) + "\n",
    );

    const run = runNodeScript(
      [
        scriptPath,
        "query",
        "--db",
        dbPath,
        "--query",
        "hello",
        "--dimensions",
        "4",
      ],
      { cwd: dir, env: { AI_GATEWAY_API_KEY: "test-key" } },
    );

    assert.equal(run.status, 1);
    assert.match(
      run.stderr,
      /--dimensions must match the indexed dimensions \(3\) when querying an existing index/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildTranscriptionScript rejects missing --file at runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-transcription-"));
  try {
    const scriptPath = await writeGeneratedFile(
      dir,
      "transcribe.mjs",
      buildTranscriptionScript(),
    );

    const result = runNodeScript(
      [scriptPath],
      { cwd: dir, env: { AI_GATEWAY_API_KEY: "test-key" } },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildTranscriptionScript rejects invalid --format at runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-transcription-fmt-"));
  try {
    const scriptPath = await writeGeneratedFile(
      dir,
      "transcribe.mjs",
      buildTranscriptionScript(),
    );

    const result = runNodeScript(
      [scriptPath, "--file", "dummy.mp3", "--format", "invalid"],
      { cwd: dir, env: { AI_GATEWAY_API_KEY: "test-key" } },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--format must be one of/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildReasoningScript rejects invalid --reasoning-effort at runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-reasoning-"));
  try {
    const scriptPath = await writeGeneratedFile(
      dir,
      "reason.mjs",
      buildReasoningScript(),
    );

    const result = runNodeScript(
      [scriptPath, "--prompt", "test", "--reasoning-effort", "extreme"],
      { cwd: dir, env: { AI_GATEWAY_API_KEY: "test-key" } },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--reasoning-effort must be one of/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildReasoningScript rejects missing prompt at runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-reasoning-noprompt-"));
  try {
    const scriptPath = await writeGeneratedFile(
      dir,
      "reason.mjs",
      buildReasoningScript(),
    );

    const result = runNodeScript(
      [scriptPath],
      { cwd: dir, env: { AI_GATEWAY_API_KEY: "test-key" } },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--prompt/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Compare models skill ---

test("buildCompareSkill returns valid skill metadata", () => {
  const skill = buildCompareSkill();
  assert.ok(skill.includes("name: compare-models"));
  assert.ok(skill.includes("AI_GATEWAY_API_KEY"));
});

test("buildCompareScript uses chat completions and Promise.all", () => {
  const script = buildCompareScript();
  assert.ok(script.includes("/v1/chat/completions"));
  assert.ok(script.includes("Promise.all"));
  assert.ok(script.includes("--models"));
});

test("buildCompareScript rejects missing prompt at runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-compare-noprompt-"));
  try {
    const scriptPath = await writeGeneratedFile(
      dir,
      "compare.mjs",
      buildCompareScript(),
    );

    const result = runNodeScript(
      [scriptPath],
      { cwd: dir, env: { AI_GATEWAY_API_KEY: "test-key" } },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--prompt/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildCompareScript rejects single model at runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-compare-onemodel-"));
  try {
    const scriptPath = await writeGeneratedFile(
      dir,
      "compare.mjs",
      buildCompareScript(),
    );

    const result = runNodeScript(
      [scriptPath, "--prompt", "hello", "--models", "gpt-4o"],
      { cwd: dir, env: { AI_GATEWAY_API_KEY: "test-key" } },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /at least two/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildReasoningScript extracts summary from reasoning_details at runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-reasoning-summary-"));
  try {
    const scriptPath = await writeGeneratedFile(
      dir,
      "reason.mjs",
      buildReasoningScript(),
    );

    const preloadPath = await writeGeneratedFile(
      dir,
      "mock-fetch.mjs",
      `globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (body.reasoning?.effort !== "xhigh") {
    return new Response("unexpected effort", { status: 400 });
  }
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: "Final answer.",
            reasoning_details: [
              {
                type: "reasoning.summary",
                summary: "First analyze the problem.",
              },
            ],
          },
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};`,
    );

    const result = runNodeScript(
      [
        "--import",
        preloadPath,
        scriptPath,
        "--prompt",
        "test",
        "--reasoning-effort",
        "xhigh",
      ],
      { cwd: dir, env: { AI_GATEWAY_API_KEY: "test-key" } },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Reasoning:\nFirst analyze the problem\./);
    assert.match(result.stdout, /Final answer\./);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildCompareScript normalizes common shorthand model ids at runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-compare-normalize-"));
  try {
    const scriptPath = await writeGeneratedFile(
      dir,
      "compare.mjs",
      buildCompareScript(),
    );

    const preloadPath = await writeGeneratedFile(
      dir,
      "mock-fetch.mjs",
      `globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body ?? "{}"));
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: body.model } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};`,
    );

    const result = runNodeScript(
      [
        "--import",
        preloadPath,
        scriptPath,
        "--prompt",
        "hello",
        "--models",
        "gpt-4o,claude-sonnet-4.6",
      ],
      { cwd: dir, env: { AI_GATEWAY_API_KEY: "test-key" } },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /## openai\/gpt-4o/);
    assert.match(result.stdout, /## anthropic\/claude-sonnet-4.6/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
