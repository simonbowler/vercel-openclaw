import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import test from "node:test";

import { RetryableSendError } from "@/server/channels/core/types";
import {
  createWhatsAppAdapter,
  extractWhatsAppMessageId,
  isWhatsAppSignatureValid,
} from "@/server/channels/whatsapp/adapter";

const CONFIG = {
  enabled: true,
  configuredAt: Date.now(),
  phoneNumberId: "123456789",
  accessToken: "wa-access-token",
  verifyToken: "wa-verify-token",
  appSecret: "wa-app-secret",
};

test("isWhatsAppSignatureValid accepts a valid sha256 HMAC signature", () => {
  const rawBody = JSON.stringify({ hello: "world" });
  const digest = crypto.createHmac("sha256", CONFIG.appSecret).update(rawBody).digest("hex");

  assert.equal(
    isWhatsAppSignatureValid(CONFIG.appSecret, rawBody, `sha256=${digest}`),
    true,
  );
  assert.equal(
    isWhatsAppSignatureValid(CONFIG.appSecret, rawBody, "sha256=deadbeef"),
    false,
  );
});

test("createWhatsAppAdapter extracts inbound text messages", async () => {
  const adapter = createWhatsAppAdapter(CONFIG);
  const result = await adapter.extractMessage({
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "123456789" },
              contacts: [{ profile: { name: "Test User" }, wa_id: "15551234567" }],
              messages: [
                {
                  id: "wamid.abc123",
                  from: "15551234567",
                  type: "text",
                  text: { body: "hello whatsapp" },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  assert.equal(result.kind, "message");
  if (result.kind !== "message") return;

  assert.equal(result.message.text, "hello whatsapp");
  assert.equal(result.message.from, "15551234567");
  assert.equal(result.message.messageId, "wamid.abc123");
  assert.equal(result.message.phoneNumberId, "123456789");
  assert.equal(result.message.name, "Test User");
});

test("createWhatsAppAdapter skips statuses-only payloads", async () => {
  const adapter = createWhatsAppAdapter(CONFIG);
  const result = await adapter.extractMessage({
    entry: [{ changes: [{ value: { statuses: [{ id: "wamid.abc123" }] } }] }],
  });

  assert.deepEqual(result, { kind: "skip", reason: "no_messages" });
});

test("extractWhatsAppMessageId returns the first inbound message id", () => {
  assert.equal(
    extractWhatsAppMessageId({
      entry: [{ changes: [{ value: { messages: [{ id: "wamid.1" }] } }] }],
    }),
    "wamid.1",
  );
});

test("createWhatsAppAdapter buildGatewayMessages formats history plus user message", async () => {
  const adapter = createWhatsAppAdapter(CONFIG);
  const messages = await adapter.buildGatewayMessages?.({
    text: "hello whatsapp",
    from: "15551234567",
    messageId: "wamid.abc123",
    phoneNumberId: "123456789",
    history: [{ role: "assistant", content: "prior reply" }],
  });

  assert.deepEqual(messages, [
    { role: "assistant", content: "prior reply" },
    { role: "user", content: "hello whatsapp" },
  ]);
});

test("createWhatsAppAdapter getSessionKey uses sender wa_id", () => {
  const adapter = createWhatsAppAdapter(CONFIG);
  assert.equal(
    adapter.getSessionKey?.({
      text: "hello whatsapp",
      from: "15551234567",
      messageId: "wamid.abc123",
      phoneNumberId: "123456789",
    }),
    "whatsapp:dm:15551234567",
  );
});

test("createWhatsAppAdapter sendReply posts outbound message", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: string[] = [];

  globalThis.fetch = async (_input, init) => {
    bodies.push(String(init?.body ?? ""));
    return Response.json({
      messaging_product: "whatsapp",
      messages: [{ id: "wamid.sent1" }],
    });
  };

  try {
    const adapter = createWhatsAppAdapter(CONFIG);
    await adapter.sendReply(
      {
        text: "hi",
        from: "15551234567",
        messageId: "wamid.input",
        phoneNumberId: CONFIG.phoneNumberId,
      },
      "reply",
    );

    const body = JSON.parse(bodies[0] ?? "{}");
    assert.equal(body.to, "15551234567");
    assert.equal(body.text.body, "reply");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createWhatsAppAdapter sendBootMessage sends starting message", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: string[] = [];

  globalThis.fetch = async (_input, init) => {
    bodies.push(String(init?.body ?? ""));
    return Response.json({
      messaging_product: "whatsapp",
      messages: [{ id: "wamid.boot1" }],
    });
  };

  try {
    const adapter = createWhatsAppAdapter(CONFIG);
    const handle = await adapter.sendBootMessage?.(
      {
        text: "hi",
        from: "15551234567",
        messageId: "wamid.input",
        phoneNumberId: CONFIG.phoneNumberId,
      },
      "Starting up...",
    );

    const body = JSON.parse(bodies[0] ?? "{}");
    assert.equal(body.text.body, "Starting up...");
    await handle?.update("ignored");
    await handle?.clear();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createWhatsAppAdapter startProcessingIndicator marks message as read immediately and stops cleanly", async () => {
  const bodies: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    bodies.push(String(init?.body ?? ""));
    return Response.json({ messaging_product: "whatsapp" });
  };

  try {
    const adapter = createWhatsAppAdapter(CONFIG);
    const indicator = await adapter.startProcessingIndicator?.({
      text: "hi",
      from: "15551234567",
      messageId: "wamid.input",
      phoneNumberId: CONFIG.phoneNumberId,
    });

    assert.ok(indicator, "startProcessingIndicator should return an indicator");
    assert.equal(bodies.length, 1, "should fire first pulse immediately");

    const body = JSON.parse(bodies[0] ?? "{}");
    assert.equal(body.status, "read");
    assert.equal(body.message_id, "wamid.input");

    await indicator?.stop();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createWhatsAppAdapter sendReply throws RetryableSendError on rate limit", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          message: "rate limited",
          code: 4,
        },
      }),
      { status: 429, headers: { "content-type": "application/json" } },
    );

  try {
    const adapter = createWhatsAppAdapter(CONFIG);
    await assert.rejects(
      adapter.sendReply(
        {
          text: "hi",
          from: "15551234567",
          messageId: "wamid.input",
          phoneNumberId: CONFIG.phoneNumberId,
        },
        "reply",
      ),
      (error) => {
        assert.ok(error instanceof RetryableSendError);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

