import { requireJsonRouteAuth } from "@/server/auth/route-auth";
import { getChannelQueueDepth } from "@/server/channels/driver";
import { channelFailedKey } from "@/server/channels/keys";
import { logError } from "@/server/log";
import { getStore, getInitializedMeta } from "@/server/store/store";
import { jsonError } from "@/shared/http";

type ChannelSummaryEntry = {
  connected: boolean;
  queueDepth: number;
  failedCount: number;
  lastError: string | null;
};

type ChannelSummaryResponse = {
  slack: ChannelSummaryEntry;
  telegram: ChannelSummaryEntry;
  discord: ChannelSummaryEntry;
};

async function getFailedCount(channel: "slack" | "telegram" | "discord"): Promise<number> {
  try {
    return await getStore().getQueueLength(channelFailedKey(channel));
  } catch {
    return 0;
  }
}

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const meta = await getInitializedMeta();
    const [
      slackQueue,
      telegramQueue,
      discordQueue,
      slackDL,
      telegramDL,
      discordDL,
    ] = await Promise.all([
      getChannelQueueDepth("slack"),
      getChannelQueueDepth("telegram"),
      getChannelQueueDepth("discord"),
      getFailedCount("slack"),
      getFailedCount("telegram"),
      getFailedCount("discord"),
    ]);

    const body: ChannelSummaryResponse = {
      slack: {
        connected: meta.channels.slack !== null,
        queueDepth: slackQueue,
        failedCount: slackDL,
        lastError: meta.channels.slack?.lastError ?? null,
      },
      telegram: {
        connected: meta.channels.telegram !== null,
        queueDepth: telegramQueue,
        failedCount: telegramDL,
        lastError: meta.channels.telegram?.lastError ?? null,
      },
      discord: {
        connected: meta.channels.discord !== null,
        queueDepth: discordQueue,
        failedCount: discordDL,
        lastError: meta.channels.discord?.endpointError ?? null,
      },
    };

    const response = Response.json(body);
    if (auth.setCookieHeader) {
      response.headers.append("Set-Cookie", auth.setCookieHeader);
    }
    return response;
  } catch (error) {
    logError("channels.summary_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonError(error);
  }
}
