import type { ChannelName } from "@/shared/channels";
import type { PublicChannelState } from "@/shared/channel-admin-state";
import type { SingleMeta } from "@/shared/types";
import { authJsonError, authJsonOk, requireJsonRouteAuth } from "@/server/auth/route-auth";
import {
  buildChannelConnectability,
  buildChannelConnectBlockedResponse,
} from "@/server/channels/connectability";
import { getPublicChannelState } from "@/server/channels/state";
import { logInfo, logWarn } from "@/server/log";
import { syncGatewayConfigToSandbox } from "@/server/sandbox/lifecycle";
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

        // Sync updated config to the running sandbox so OpenClaw's file
        // watcher hot-reloads the channel without a gateway restart.
        try {
          const syncResult = await syncGatewayConfigToSandbox();
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
        }

        const nextState = spec.selectState(await getPublicChannelState(request));
        return authJsonOk(nextState, auth);
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

        // Sync updated config to the running sandbox so OpenClaw's file
        // watcher removes the channel without a gateway restart.
        try {
          const syncResult = await syncGatewayConfigToSandbox();
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
        }

        const nextState = spec.selectState(await getPublicChannelState(request));
        return authJsonOk(nextState, auth);
      } catch (error) {
        return authJsonError(error, auth);
      }
    },
  };
}
