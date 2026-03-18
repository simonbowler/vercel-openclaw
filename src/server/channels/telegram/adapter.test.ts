import assert from "node:assert/strict";
import test from "node:test";

import { RetryableSendError } from "@/server/channels/core/types";
import {
  createTelegramAdapter,
  isTelegramWebhookSecretValid,
  normalizeTelegramSlashCommand,
} from "@/server/channels/telegram/adapter";

test("isTelegramWebhookSecretValid accepts current and unexpired previous secrets", () => {
  const now = Date.now();
  const config = {
    botToken: "bot-token",
    webhookSecret: "current-secret",
    previousWebhookSecret: "previous-secret",
    previousSecretExpiresAt: now + 60_000,
    webhookUrl: "https://example.com/api/channels/telegram/webhook",
    botUsername: "openclaw_bot",
    configuredAt: now,
  };

  assert.equal(isTelegramWebhookSecretValid(config, "current-secret", now), true);
  assert.equal(isTelegramWebhookSecretValid(config, "previous-secret", now), true);
  assert.equal(isTelegramWebhookSecretValid(config, "previous-secret", now + 120_000), false);
});

test("createTelegramAdapter extracts chat text updates", async () => {
  const adapter = createTelegramAdapter({
    botToken: "bot-token",
    webhookSecret: "secret",
    webhookUrl: "https://example.com/api/channels/telegram/webhook",
    botUsername: "openclaw_bot",
    configuredAt: Date.now(),
  });

  const result = await adapter.extractMessage({
    update_id: 1,
    message: {
      text: "hello telegram",
      chat: {
        id: 42,
      },
    },
  });

  assert.equal(result.kind, "message");
  if (result.kind !== "message") {
    return;
  }

  assert.equal(result.message.text, "hello telegram");
  assert.equal(result.message.chatId, "42");
});

test("normalizeTelegramSlashCommand strips matching bot mention", () => {
  assert.deepEqual(
    normalizeTelegramSlashCommand("/ask@openclaw_bot hi there", "openclaw_bot"),
    { shouldHandle: true, text: "/ask hi there" },
  );
});

test("createTelegramAdapter skips slash commands addressed to another bot", async () => {
  const adapter = createTelegramAdapter({
    botToken: "bot-token",
    webhookSecret: "secret",
    webhookUrl: "https://example.com/api/channels/telegram/webhook",
    botUsername: "openclaw_bot",
    configuredAt: Date.now(),
  });

  const result = await adapter.extractMessage({
    update_id: 1,
    message: {
      text: "/ask@other_bot hi",
      chat: {
        id: 42,
      },
    },
  });

  assert.deepEqual(result, { kind: "skip", reason: "command_for_other_bot" });
});

test("createTelegramAdapter normalizes matching slash commands in group chats", async () => {
  const adapter = createTelegramAdapter({
    botToken: "bot-token",
    webhookSecret: "secret",
    webhookUrl: "https://example.com/api/channels/telegram/webhook",
    botUsername: "openclaw_bot",
    configuredAt: Date.now(),
  });

  const result = await adapter.extractMessage({
    update_id: 1,
    message: {
      text: "/ask@openclaw_bot hi",
      chat: {
        id: 42,
      },
    },
  });

  assert.equal(result.kind, "message");
  if (result.kind !== "message") {
    return;
  }

  assert.equal(result.message.text, "/ask hi");
});

test("createTelegramAdapter startProcessingIndicator triggers chat action immediately and stops cleanly", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
    });
  };

  try {
    const adapter = createTelegramAdapter({
      botToken: "bot-token",
      webhookSecret: "secret",
      webhookUrl: "https://example.com/api/channels/telegram/webhook",
      botUsername: "openclaw_bot",
      configuredAt: Date.now(),
    });

    const indicator = await adapter.startProcessingIndicator?.({
      text: "hello telegram",
      chatId: "42",
    });

    assert.ok(indicator, "startProcessingIndicator should return an indicator");
    assert.equal(calls.length, 1, "should fire first pulse immediately");
    assert.ok(
      calls[0]?.includes("sendChatAction"),
      "should call sendChatAction",
    );

    await indicator.stop();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createTelegramAdapter sendReply throws RetryableSendError when Telegram rate limits", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        ok: false,
        error_code: 429,
        description: "Too Many Requests",
        parameters: {
          retry_after: 11,
        },
      }),
      {
        status: 429,
      },
    );

  try {
    const adapter = createTelegramAdapter({
      botToken: "bot-token",
      webhookSecret: "secret",
      webhookUrl: "https://example.com/api/channels/telegram/webhook",
      botUsername: "openclaw_bot",
      configuredAt: Date.now(),
    });

    await assert.rejects(
      adapter.sendReply(
        {
          text: "hello telegram",
          chatId: "42",
        },
        "reply text",
      ),
      (error) => {
        assert.ok(error instanceof RetryableSendError);
        assert.equal(error.retryAfterSeconds, 11);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
