import assert from "node:assert/strict";
import test from "node:test";

import {
  clampWhatsAppText,
  deleteMessage,
  markAsRead,
  sendMessage,
  WhatsAppApiClient,
  WhatsAppApiError,
} from "@/server/channels/whatsapp/whatsapp-api";

test("clampWhatsAppText truncates long messages", () => {
  assert.equal(clampWhatsAppText("abcdef", 5), "ab...");
  assert.equal(clampWhatsAppText("abc", 5), "abc");
});

test("sendMessage posts WhatsApp text payload and returns outbound id", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedBody = "";
  let capturedAuth = "";

  globalThis.fetch = async (input, init) => {
    capturedUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    capturedBody = String(init?.body ?? "");
    capturedAuth = String((init?.headers as Record<string, string>)?.authorization ?? "");
    return Response.json({
      messaging_product: "whatsapp",
      contacts: [{ input: "15551234567", wa_id: "15551234567" }],
      messages: [{ id: "wamid.sent123" }],
    });
  };

  try {
    const result = await sendMessage("token", "phone-1", "15551234567", "hello");
    assert.equal(result.id, "wamid.sent123");
    assert.equal(capturedUrl, "https://graph.facebook.com/v21.0/phone-1/messages");
    assert.equal(capturedAuth, "Bearer token");

    const body = JSON.parse(capturedBody);
    assert.equal(body.messaging_product, "whatsapp");
    assert.equal(body.to, "15551234567");
    assert.equal(body.type, "text");
    assert.equal(body.text.body, "hello");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("markAsRead posts WhatsApp read status payload", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody = "";

  globalThis.fetch = async (_input, init) => {
    capturedBody = String(init?.body ?? "");
    return Response.json({ messaging_product: "whatsapp" });
  };

  try {
    await markAsRead("token", "phone-1", "wamid.inbound");
    const body = JSON.parse(capturedBody);
    assert.equal(body.messaging_product, "whatsapp");
    assert.equal(body.status, "read");
    assert.equal(body.message_id, "wamid.inbound");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("deleteMessage is a no-op because WhatsApp API does not support deletion", async () => {
  const result = await deleteMessage("token", "wamid.boot");
  assert.deepEqual(result, { ok: false });
});

test("WhatsAppApiClient delegates to sendMessage and markAsRead", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: string[] = [];

  globalThis.fetch = async (_input, init) => {
    bodies.push(String(init?.body ?? ""));
    return Response.json({
      messaging_product: "whatsapp",
      messages: [{ id: "wamid.sent456" }],
    });
  };

  try {
    const client = new WhatsAppApiClient({
      accessToken: "token",
      phoneNumberId: "phone-1",
    });

    const sent = await client.sendMessage("15551234567", "hello");
    await client.markAsRead("wamid.inbound");

    assert.equal(sent.id, "wamid.sent456");
    assert.equal(bodies.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendMessage throws WhatsAppApiError on API failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          message: "bad request",
          code: 100,
        },
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );

  try {
    await assert.rejects(
      sendMessage("token", "phone-1", "15551234567", "hello"),
      (error) => {
        assert.ok(error instanceof WhatsAppApiError);
        assert.equal(error.statusCode, 400);
        assert.equal(error.code, 100);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
