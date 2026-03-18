import { ApiError } from "@/shared/http";
import { authJsonError, authJsonOk, requireJsonRouteAuth } from "@/server/auth/route-auth";
import { registerAskCommand } from "@/server/channels/discord/commands";
import { setDiscordChannelConfig } from "@/server/channels/state";
import { getInitializedMeta } from "@/server/store/store";

export async function POST(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const meta = await getInitializedMeta();
    const config = meta.channels.discord;
    if (!config) {
      throw new ApiError(409, "DISCORD_NOT_CONFIGURED", "Discord is not configured.");
    }

    const command = await registerAskCommand(config.applicationId, config.botToken);
    await setDiscordChannelConfig({
      ...config,
      commandRegistered: true,
      commandId: command.commandId,
      commandRegisteredAt: Date.now(),
    });

    return authJsonOk(
      {
        ok: true,
        commandId: command.commandId ?? null,
      },
      auth,
    );
  } catch (error) {
    return authJsonError(error, auth);
  }
}
