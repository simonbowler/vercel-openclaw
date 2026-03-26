import { requireJsonRouteAuth } from "@/server/auth/route-auth";
import { logError } from "@/server/log";
import { getInitializedMeta } from "@/server/store/store";
import { jsonError } from "@/shared/http";

type ChannelSummaryEntry = {
  connected: boolean;
  lastError: string | null;
};

type WhatsAppSummaryEntry = ChannelSummaryEntry & {
  deliveryMode: "gateway-native";
  requiresRunningSandbox: true;
};

type ChannelSummaryResponse = {
  slack: ChannelSummaryEntry;
  telegram: ChannelSummaryEntry;
  discord: ChannelSummaryEntry;
  whatsapp: WhatsAppSummaryEntry;
};

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const meta = await getInitializedMeta();

    const body: ChannelSummaryResponse = {
      slack: {
        connected: meta.channels.slack !== null,
        lastError: meta.channels.slack?.lastError ?? null,
      },
      telegram: {
        connected: meta.channels.telegram !== null,
        lastError: meta.channels.telegram?.lastError ?? null,
      },
      discord: {
        connected: meta.channels.discord !== null,
        lastError: meta.channels.discord?.endpointError ?? null,
      },
      whatsapp: {
        // Contract: "connected" means enabled/configured for delivery,
        // not verified linked-session health. Use /api/channels/whatsapp
        // for detailed link state (lastKnownLinkState, linkedPhone, etc.).
        connected: meta.channels.whatsapp?.enabled === true,
        lastError: meta.channels.whatsapp?.lastError ?? null,
        deliveryMode: "gateway-native",
        requiresRunningSandbox: true,
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
