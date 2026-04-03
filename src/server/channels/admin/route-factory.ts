import type { ChannelName } from "@/shared/channels";
import type { PublicChannelState } from "@/shared/channel-admin-state";
import type { LiveConfigSyncResult } from "@/shared/live-config-sync";
import {
  LIVE_CONFIG_SYNC_OUTCOME_HEADER,
  LIVE_CONFIG_SYNC_MESSAGE_HEADER,
} from "@/shared/live-config-sync";
import type { SingleMeta } from "@/shared/types";
import { authJsonError, authJsonOk, requireJsonRouteAuth } from "@/server/auth/route-auth";
import {
  buildChannelConnectability,
  buildChannelConnectBlockedResponse,
} from "@/server/channels/connectability";
import { getPublicChannelState } from "@/server/channels/state";
import { logInfo, logWarn } from "@/server/log";
import {
  markRestoreTargetDirty,
  syncGatewayConfigToSandbox,
} from "@/server/sandbox/lifecycle";
import { getInitializedMeta } from "@/server/store/store";

type RouteAuth = Exclude<Awaited<ReturnType<typeof requireJsonRouteAuth>>, Response>;

export type ChannelRouteContext = {
  request: Request;
  auth: RouteAuth;
  meta: SingleMeta;
  url: URL;
};

export type ChannelGetContext<TState> = ChannelRouteContext & {
  fullState: PublicChannelState;
  state: TState;
};

export type ChannelAdminRouteSpec<TState> = {
  channel: ChannelName;
  selectState(fullState: PublicChannelState): TState;
  get?(context: ChannelGetContext<TState>): Promise<unknown | Response>;
  put(context: ChannelRouteContext): Promise<void | Response>;
  delete(context: ChannelRouteContext): Promise<void | Response>;
};

export function createChannelAdminRouteHandlers<TState>(
  spec: ChannelAdminRouteSpec<TState>,
): {
  GET(request: Request): Promise<Response>;
  PUT(request: Request): Promise<Response>;
  DELETE(request: Request): Promise<Response>;
} {
  return {
    async GET(request: Request): Promise<Response> {
      const auth = await requireJsonRouteAuth(request);
      if (auth instanceof Response) {
        return auth;
      }

      try {
        const meta = await getInitializedMeta();
        const fullState = await getPublicChannelState(request, meta);
        const state = spec.selectState(fullState);
        const result = spec.get
          ? await spec.get({
              request,
              auth,
              meta,
              url: new URL(request.url),
              fullState,
              state,
            })
          : state;

        return result instanceof Response ? result : authJsonOk(result, auth);
      } catch (error) {
        return authJsonError(error, auth);
      }
    },

    async PUT(request: Request): Promise<Response> {
      const auth = await requireJsonRouteAuth(request);
      if (auth instanceof Response) {
        return auth;
      }

      try {
        const connectability = await buildChannelConnectability(spec.channel, request);
        if (!connectability.canConnect) {
          return buildChannelConnectBlockedResponse(auth, connectability);
        }

        const meta = await getInitializedMeta();
        const result = await spec.put({
          request,
          auth,
          meta,
          url: new URL(request.url),
        });
        if (result instanceof Response) {
          return result;
        }

        // Channel config changed — mark restore target dirty so operators
        // know the next restore will not match the current snapshot image.
        await markRestoreTargetDirty({ reason: "dynamic-config-changed" });

        // Sync updated config to the running sandbox and restart the
        // gateway so new HTTP routes (e.g. /slack/events) are registered.
        let syncResult: LiveConfigSyncResult;
        try {
          syncResult = await syncGatewayConfigToSandbox();
          logInfo("channels.admin_config_synced", {
            channel: spec.channel,
            operation: "put",
            ...syncResult,
          });
        } catch (syncError) {
          logWarn("channels.admin_config_sync_failed", {
            channel: spec.channel,
            operation: "put",
            error: syncError instanceof Error ? syncError.message : String(syncError),
          });
          syncResult = {
            outcome: "failed",
            reason: syncError instanceof Error ? syncError.message : String(syncError),
            liveConfigFresh: false,
            operatorMessage: "Config sync failed. The sandbox may be serving stale configuration.",
          };
        }

        if (syncResult.outcome === "degraded" || syncResult.outcome === "failed") {
          logWarn("channels.admin_config_sync_degraded", {
            channel: spec.channel,
            operation: "put",
            reason: syncResult.reason,
          });
        }

        const nextState = spec.selectState(await getPublicChannelState(request));
        const response = authJsonOk(nextState, auth);
        return attachLiveConfigSyncHeaders(response, syncResult);
      } catch (error) {
        return authJsonError(error, auth);
      }
    },

    async DELETE(request: Request): Promise<Response> {
      const auth = await requireJsonRouteAuth(request);
      if (auth instanceof Response) {
        return auth;
      }

      try {
        const meta = await getInitializedMeta();
        const result = await spec.delete({
          request,
          auth,
          meta,
          url: new URL(request.url),
        });
        if (result instanceof Response) {
          return result;
        }

        // Channel config removed — mark restore target dirty.
        await markRestoreTargetDirty({ reason: "dynamic-config-changed" });

        // Sync updated config to the running sandbox and restart the
        // gateway so removed channel routes are cleaned up.
        let syncResult: LiveConfigSyncResult;
        try {
          syncResult = await syncGatewayConfigToSandbox();
          logInfo("channels.admin_config_synced", {
            channel: spec.channel,
            operation: "delete",
            ...syncResult,
          });
        } catch (syncError) {
          logWarn("channels.admin_config_sync_failed", {
            channel: spec.channel,
            operation: "delete",
            error: syncError instanceof Error ? syncError.message : String(syncError),
          });
          syncResult = {
            outcome: "failed",
            reason: syncError instanceof Error ? syncError.message : String(syncError),
            liveConfigFresh: false,
            operatorMessage: "Config sync failed. The sandbox may be serving stale configuration.",
          };
        }

        if (syncResult.outcome === "degraded" || syncResult.outcome === "failed") {
          logWarn("channels.admin_config_sync_degraded", {
            channel: spec.channel,
            operation: "delete",
            reason: syncResult.reason,
          });
        }

        const nextState = spec.selectState(await getPublicChannelState(request));
        const response = authJsonOk(nextState, auth);
        return attachLiveConfigSyncHeaders(response, syncResult);
      } catch (error) {
        return authJsonError(error, auth);
      }
    },
  };
}

function attachLiveConfigSyncHeaders(
  response: Response,
  syncResult: LiveConfigSyncResult,
): Response {
  response.headers.set(LIVE_CONFIG_SYNC_OUTCOME_HEADER, syncResult.outcome);
  if (syncResult.operatorMessage) {
    response.headers.set(LIVE_CONFIG_SYNC_MESSAGE_HEADER, syncResult.operatorMessage);
  }
  return response;
}
