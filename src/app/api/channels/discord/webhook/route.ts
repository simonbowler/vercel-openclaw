import { getPublicOrigin } from "@/server/public-url";
import { enqueueChannelJob } from "@/server/channels/driver";
import { verifyDiscordRequestSignature } from "@/server/channels/discord/adapter";
import { channelDedupKey } from "@/server/channels/keys";
import { publishToChannelQueue } from "@/server/channels/queue";
import { logInfo } from "@/server/log";
import { getInitializedMeta, getStore } from "@/server/store/store";

function extractInteractionId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const raw = payload as { id?: unknown };
  if (typeof raw.id === "string" && raw.id.length > 0) {
    return raw.id;
  }

  return null;
}

export async function POST(request: Request): Promise<Response> {
  const meta = await getInitializedMeta();
  const config = meta.channels.discord;
  if (!config) {
    return Response.json(
      { error: "DISCORD_NOT_CONFIGURED", message: "Discord is not configured." },
      { status: 409 },
    );
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-signature-ed25519") ?? "";
  const timestamp = request.headers.get("x-signature-timestamp") ?? "";
  if (!verifyDiscordRequestSignature(rawBody, signature, timestamp, config.publicKey)) {
    return Response.json(
      { error: "DISCORD_SIGNATURE_INVALID", message: "Invalid Discord request signature." },
      { status: 401 },
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json(
      { error: "INVALID_JSON_BODY", message: "Invalid JSON body." },
      { status: 400 },
    );
  }

  if ((payload as { type?: unknown }).type === 1) {
    return Response.json({ type: 1 });
  }

  const interactionId = extractInteractionId(payload);
  if (interactionId) {
    const accepted = await getStore().acquireLock(channelDedupKey("discord", interactionId), 24 * 60 * 60);
    if (!accepted) {
      return Response.json({ type: 5 });
    }
  }

  const job = {
    payload,
    receivedAt: Date.now(),
    origin: getPublicOrigin(request),
  };

  const { queued } = await publishToChannelQueue("discord", job);
  if (!queued) {
    await enqueueChannelJob("discord", job);
    logInfo("channels.discord_webhook_fallback_enqueue", { receivedAt: job.receivedAt });
  }

  return Response.json({ type: 5 });
}
