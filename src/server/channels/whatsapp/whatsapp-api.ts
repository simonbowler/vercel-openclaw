const WHATSAPP_API_BASE = "https://graph.facebook.com/v21.0";
const WHATSAPP_REQUEST_TIMEOUT_MS = 15_000;
const WHATSAPP_MAX_TEXT_LEN = 4_096;
const WHATSAPP_TRUNCATION_MARKER = "...";

type WhatsAppApiEnvelope<T> = {
  messaging_product?: string;
  contacts?: Array<{
    input?: string;
    wa_id?: string;
  }>;
  messages?: T[];
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
};

export type WhatsAppSendMessageResult = {
  id: string;
};

export type WhatsAppDeleteMessageResult = {
  ok: false;
};

export class WhatsAppApiError extends Error {
  readonly method: string;
  readonly statusCode: number;
  readonly code: number | null;

  constructor(options: {
    method: string;
    statusCode: number;
    message: string;
    code?: number | null;
  }) {
    super(`WhatsApp ${options.method} failed (${options.statusCode}): ${options.message}`);
    this.name = "WhatsAppApiError";
    this.method = options.method;
    this.statusCode = options.statusCode;
    this.code = options.code ?? null;
  }
}

export function clampWhatsAppText(text: string, maxLen = WHATSAPP_MAX_TEXT_LEN): string {
  if (maxLen <= 0) return "";
  if (text.length <= maxLen) return text;
  if (maxLen <= WHATSAPP_TRUNCATION_MARKER.length) {
    return WHATSAPP_TRUNCATION_MARKER.slice(0, maxLen);
  }
  return `${text.slice(0, maxLen - WHATSAPP_TRUNCATION_MARKER.length)}${WHATSAPP_TRUNCATION_MARKER}`;
}

function isLikelyNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();
  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econn") ||
    message.includes("enotfound") ||
    message.includes("socket")
  );
}

export function isRetryableWhatsAppSendError(error: unknown): boolean {
  if (error instanceof WhatsAppApiError) {
    return error.statusCode === 429 || error.statusCode >= 500;
  }

  return isLikelyNetworkError(error);
}

function buildMessagesUrl(phoneNumberId: string): string {
  return `${WHATSAPP_API_BASE}/${encodeURIComponent(phoneNumberId)}/messages`;
}

async function parseWhatsAppEnvelope<T>(
  response: Response,
): Promise<WhatsAppApiEnvelope<T> | null> {
  try {
    return (await response.json()) as WhatsAppApiEnvelope<T>;
  } catch {
    return null;
  }
}

async function callWhatsAppApi<T>(
  accessToken: string,
  phoneNumberId: string,
  body: Record<string, unknown>,
): Promise<WhatsAppApiEnvelope<T>> {
  const response = await fetch(buildMessagesUrl(phoneNumberId), {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(WHATSAPP_REQUEST_TIMEOUT_MS),
  });

  const payload = await parseWhatsAppEnvelope<T>(response);
  if (!response.ok || payload?.error) {
    throw new WhatsAppApiError({
      method: "POST",
      statusCode: response.status,
      message: payload?.error?.message ?? `HTTP ${response.status}`,
      code: payload?.error?.code ?? null,
    });
  }

  return payload ?? {};
}

export class WhatsAppApiClient {
  readonly accessToken: string;
  readonly phoneNumberId: string;

  constructor(options: { accessToken: string; phoneNumberId: string }) {
    this.accessToken = options.accessToken;
    this.phoneNumberId = options.phoneNumberId;
  }

  async sendMessage(to: string, text: string): Promise<WhatsAppSendMessageResult> {
    const payload = await callWhatsAppApi<WhatsAppSendMessageResult>(
      this.accessToken,
      this.phoneNumberId,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: {
          body: clampWhatsAppText(text),
        },
      },
    );

    const message = payload.messages?.[0];
    if (!message?.id) {
      throw new WhatsAppApiError({
        method: "POST",
        statusCode: 502,
        message: "Missing message id in WhatsApp response",
      });
    }

    return message;
  }

  async markAsRead(messageId: string): Promise<void> {
    await callWhatsAppApi<never>(this.accessToken, this.phoneNumberId, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    });
  }

  async deleteMessage(): Promise<WhatsAppDeleteMessageResult> {
    return { ok: false };
  }
}

export async function sendMessage(
  accessToken: string,
  phoneNumberId: string,
  to: string,
  text: string,
): Promise<WhatsAppSendMessageResult> {
  return new WhatsAppApiClient({ accessToken, phoneNumberId }).sendMessage(to, text);
}

export async function markAsRead(
  accessToken: string,
  phoneNumberId: string,
  messageId: string,
): Promise<void> {
  await new WhatsAppApiClient({ accessToken, phoneNumberId }).markAsRead(messageId);
}

export async function deleteMessage(
  _accessToken: string,
  _messageId: string,
): Promise<WhatsAppDeleteMessageResult> {
  return { ok: false };
}

