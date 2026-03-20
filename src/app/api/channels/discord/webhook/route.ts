import { getPublicOrigin } from "@/server/public-url";
import { enqueueChannelJob } from "@/server/channels/driver";
import { verifyDiscordRequestSignature } from "@/server/channels/discord/adapter";
import { channelDedupKey } from "@/server/channels/keys";
import { publishToChannelQueue } from "@/server/channels/queue";
import { extractRequestId, logInfo } from "@/server/log";
import { createOperationContext, withOperationContext } from "@/server/observability/operation-context";
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
  const requestId = extractRequestId(request);
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

  const op = createOperationContext({
    trigger: "channel.discord.webhook",
    reason: "incoming discord webhook",
    requestId: requestId ?? null,
    channel: "discord",
    dedupId: interactionId ?? null,
    sandboxId: meta.sandboxId ?? null,
    snapshotId: meta.snapshotId ?? null,
    status: meta.status,
  });

  logInfo("channels.discord_webhook_accepted", withOperationContext(op));

  const job = {
    payload,
    receivedAt: Date.now(),
    origin: getPublicOrigin(request),
    opId: op.opId,
    requestId: requestId ?? null,
  };

  const { queued } = await publishToChannelQueue("discord", job);
  if (!queued) {
    await enqueueChannelJob("discord", job);
    logInfo("channels.discord_webhook_fallback_enqueue", withOperationContext(op, { receivedAt: job.receivedAt }));
  }

  return Response.json({ type: 5 });
}
