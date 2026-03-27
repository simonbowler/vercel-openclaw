import type { WhatsAppLinkState } from "@/shared/channels";
import {
  type ChannelSummaryEntry,
  type ChannelSummaryResponse,
  type WhatsAppSummaryEntry,
  WHATSAPP_CONNECTION_SEMANTICS,
  WHATSAPP_SUMMARY_DETAIL_ROUTE,
} from "@/shared/channel-summary";
import { requireJsonRouteAuth } from "@/server/auth/route-auth";
import { logError, logInfo } from "@/server/log";
import { getInitializedMeta } from "@/server/store/store";
import { jsonError } from "@/shared/http";

function buildSummaryEntry(
  configured: boolean,
  lastError: string | null,
): ChannelSummaryEntry {
  return {
    connected: configured,
    configured,
    lastError,
  };
}

function buildWhatsAppSummaryEntry(
  config:
    | {
        enabled: boolean;
        lastKnownLinkState?: WhatsAppLinkState;
        lastError?: string;
      }
    | null
    | undefined,
): WhatsAppSummaryEntry {
  const configured = config?.enabled === true;

  const entry: WhatsAppSummaryEntry = {
    connected: configured,
    configured,
    linkState: config?.lastKnownLinkState ?? "unconfigured",
    lastError: config?.lastError ?? null,
    connectionSemantics: WHATSAPP_CONNECTION_SEMANTICS,
    detailRoute: WHATSAPP_SUMMARY_DETAIL_ROUTE,
    deliveryMode: "webhook-proxied",
    requiresRunningSandbox: false,
  };

  const hasProjectionGap =
    (entry.configured && entry.linkState !== "linked") ||
    (!entry.configured && entry.linkState !== "unconfigured") ||
    entry.lastError !== null;

  if (hasProjectionGap) {
    logInfo("channels.whatsapp_summary_projected", {
      configured: entry.configured,
      connected: entry.connected,
      linkState: entry.linkState,
      lastError: entry.lastError,
      connectionSemantics: entry.connectionSemantics,
      detailRoute: entry.detailRoute,
      deliveryMode: entry.deliveryMode,
      requiresRunningSandbox: entry.requiresRunningSandbox,
    });
  }

  return entry;
}

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const meta = await getInitializedMeta();

    const body: ChannelSummaryResponse = {
      slack: buildSummaryEntry(
        meta.channels.slack !== null,
        meta.channels.slack?.lastError ?? null,
      ),
      telegram: buildSummaryEntry(
        meta.channels.telegram !== null,
        meta.channels.telegram?.lastError ?? null,
      ),
      discord: buildSummaryEntry(
        meta.channels.discord !== null,
        meta.channels.discord?.endpointError ?? null,
      ),
      whatsapp: buildWhatsAppSummaryEntry(meta.channels.whatsapp),
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
