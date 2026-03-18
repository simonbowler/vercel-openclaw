import { ApiError } from "@/shared/http";
import { authJsonError, authJsonOk, requireJsonRouteAuth } from "@/server/auth/route-auth";
import { setTelegramChannelConfig } from "@/server/channels/state";
import { syncTelegramCommands } from "@/server/channels/telegram/commands";
import { getInitializedMeta } from "@/server/store/store";

export async function POST(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const meta = await getInitializedMeta();
    const config = meta.channels.telegram;
    if (!config) {
      throw new ApiError(409, "TELEGRAM_NOT_CONFIGURED", "Telegram is not configured.");
    }

    try {
      const commands = await syncTelegramCommands(config.botToken);
      const now = Date.now();

      await setTelegramChannelConfig({
        ...config,
        commandSyncStatus: "synced",
        commandsRegisteredAt: now,
        commandSyncError: undefined,
      });

      return authJsonOk(
        {
          ok: true,
          commandCount: commands.length,
        },
        auth,
      );
    } catch (error) {
      await setTelegramChannelConfig({
        ...config,
        commandSyncStatus: "error",
        commandSyncError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  } catch (error) {
    return authJsonError(error, auth);
  }
}
