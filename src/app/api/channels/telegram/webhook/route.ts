import { getPublicOrigin } from "@/server/public-url";
import { enqueueChannelJob } from "@/server/channels/driver";
import { channelDedupKey } from "@/server/channels/keys";
import { publishToChannelQueue } from "@/server/channels/queue";
import { isTelegramWebhookSecretValid } from "@/server/channels/telegram/adapter";
import { logInfo } from "@/server/log";
import { getInitializedMeta, getStore } from "@/server/store/store";

function extractUpdateId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const raw = payload as { update_id?: unknown };
  if (typeof raw.update_id === "number") {
    return String(raw.update_id);
  }

  return null;
}

export async function POST(request: Request): Promise<Response> {
  const meta = await getInitializedMeta();
  const config = meta.channels.telegram;
  if (!config) {
    return Response.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
  }

  const secretHeader = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!secretHeader || !isTelegramWebhookSecretValid(config, secretHeader)) {
    return Response.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ ok: true });
  }

  const updateId = extractUpdateId(payload);
  if (updateId) {
    const accepted = await getStore().acquireLock(channelDedupKey("telegram", updateId), 24 * 60 * 60);
    if (!accepted) {
      return Response.json({ ok: true });
    }
  }

  const job = {
    payload,
    receivedAt: Date.now(),
    origin: getPublicOrigin(request),
  };

  const { queued } = await publishToChannelQueue("telegram", job);
  if (!queued) {
    await enqueueChannelJob("telegram", job);
    logInfo("channels.telegram_webhook_fallback_enqueue", { receivedAt: job.receivedAt });
  }

  return Response.json({ ok: true });
}
