import * as crypto from "node:crypto";

import type { WhatsAppChannelConfig } from "@/shared/channels";
import { toPlainText } from "@/server/channels/core/reply";
import { startKeepAlive } from "@/server/channels/core/processing-indicator";
import { RetryableSendError } from "@/server/channels/core/types";
import type {
  GatewayMessage,
  PlatformAdapter,
} from "@/server/channels/core/types";
import {
  isRetryableWhatsAppSendError,
  markAsRead,
  sendMessage,
} from "@/server/channels/whatsapp/whatsapp-api";

export interface WhatsAppExtractedMessage {
  text: string;
  from: string;
  messageId: string;
  phoneNumberId: string;
  name?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

type WhatsAppWebhookMessage = {
  id?: string;
  from?: string;
  type?: string;
  text?: {
    body?: string;
  };
};

type WhatsAppWebhookValue = {
  metadata?: {
    phone_number_id?: string;
  };
  contacts?: Array<{
    profile?: {
      name?: string;
    };
    wa_id?: string;
  }>;
  messages?: WhatsAppWebhookMessage[];
};

function toRetryableSendError(
  message: string,
  cause?: unknown,
): RetryableSendError {
  return new RetryableSendError(message, { cause });
}

function getFirstValue(payload: unknown): WhatsAppWebhookValue | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const entry = (payload as { entry?: unknown[] }).entry;
  if (!Array.isArray(entry) || entry.length === 0) {
    return null;
  }

  const firstEntry = entry[0];
  if (!firstEntry || typeof firstEntry !== "object") {
    return null;
  }

  const changes = (firstEntry as { changes?: unknown[] }).changes;
  if (!Array.isArray(changes) || changes.length === 0) {
    return null;
  }

  const firstChange = changes[0];
  if (!firstChange || typeof firstChange !== "object") {
    return null;
  }

  const value = (firstChange as { value?: unknown }).value;
  return value && typeof value === "object" ? (value as WhatsAppWebhookValue) : null;
}

function timingSafeEqualHex(expected: string, received: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(received, "utf8");
  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

export function isWhatsAppSignatureValid(
  appSecret: string,
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex");
  const received = signatureHeader.slice("sha256=".length);

  return timingSafeEqualHex(expected, received);
}

export function extractWhatsAppMessageId(payload: unknown): string | null {
  const message = getFirstValue(payload)?.messages?.[0];
  return typeof message?.id === "string" && message.id.length > 0 ? message.id : null;
}

export function createWhatsAppAdapter(
  config: WhatsAppChannelConfig,
): PlatformAdapter<unknown, WhatsAppExtractedMessage> {
  return {
    extractMessage(payload) {
      const value = getFirstValue(payload);
      const message = value?.messages?.[0];
      if (!message) {
        return { kind: "skip", reason: "no_messages" } as const;
      }

      if (message.type !== "text") {
        return { kind: "skip", reason: "unsupported_message_type" } as const;
      }

      const text = message.text?.body?.trim();
      if (!text) {
        return { kind: "skip", reason: "no_text" } as const;
      }

      const senderWaId = value?.contacts?.[0]?.wa_id ?? message.from;
      if (typeof senderWaId !== "string" || senderWaId.length === 0) {
        return { kind: "fail", reason: "no_sender" } as const;
      }

      if (typeof message.id !== "string" || message.id.length === 0) {
        return { kind: "fail", reason: "no_message_id" } as const;
      }

      const phoneNumberId = value?.metadata?.phone_number_id ?? config.phoneNumberId;
      if (typeof phoneNumberId !== "string" || phoneNumberId.length === 0) {
        return { kind: "fail", reason: "no_phone_number_id" } as const;
      }

      return {
        kind: "message",
        message: {
          text,
          from: senderWaId,
          messageId: message.id,
          phoneNumberId,
          name: value?.contacts?.[0]?.profile?.name,
        },
      } as const;
    },

    async sendReply(message, replyText) {
      try {
        await sendMessage(config.accessToken ?? "", message.phoneNumberId, message.from, replyText);
      } catch (error) {
        if (isRetryableWhatsAppSendError(error)) {
          throw toRetryableSendError(
            `whatsapp_send_retryable: ${error instanceof Error ? error.message : String(error)}`,
            error,
          );
        }

        throw error;
      }
    },

    async sendReplyRich(message, reply) {
      await this.sendReply(message, toPlainText(reply));
    },

    buildGatewayMessages(message): GatewayMessage[] {
      return [
        ...(message.history ?? []),
        { role: "user", content: message.text },
      ];
    },

    getSessionKey(message) {
      return `whatsapp:dm:${message.from}`;
    },

    async sendBootMessage(message, text) {
      const result = await sendMessage(
        config.accessToken ?? "",
        message.phoneNumberId,
        message.from,
        text,
      );

      return {
        async update() {
          // WhatsApp does not support editing sent messages.
        },
        async clear() {
          // Deletion is not supported by the API client.
        },
      };
    },

    async sendTypingIndicator(message) {
      await markAsRead(config.accessToken ?? "", message.phoneNumberId, message.messageId);
    },

    async startProcessingIndicator(message) {
      return startKeepAlive(async () => {
        await markAsRead(config.accessToken ?? "", message.phoneNumberId, message.messageId);
      }, 4_000);
    },
  };
}

