import type { DiscordChannelConfig } from "@/shared/channels";
import { ApiError } from "@/shared/http";
import { authJsonError, authJsonOk, requireJsonRouteAuth } from "@/server/auth/route-auth";
import {
  buildChannelConnectability,
  buildChannelConnectBlockedResponse,
} from "@/server/channels/connectability";
import {
  fetchDiscordApplicationIdentity,
  patchInteractionsEndpoint,
} from "@/server/channels/discord/application";
import { registerAskCommand } from "@/server/channels/discord/commands";
import {
  buildDiscordPublicWebhookUrl,
  getPublicChannelState,
  setDiscordChannelConfig,
} from "@/server/channels/state";
import { getInitializedMeta } from "@/server/store/store";

function normalizeBotToken(value: unknown): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_DISCORD_BOT_TOKEN", "Discord botToken must be a string");
  }

  const normalized = value.trim().replace(/^Bot\s+/i, "").trim();
  if (normalized.length === 0) {
    throw new ApiError(400, "INVALID_DISCORD_BOT_TOKEN", "Discord botToken is required");
  }

  return normalized;
}

function parseOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new ApiError(400, "INVALID_REQUEST_BODY", `${fieldName} must be a boolean`);
  }

  return value;
}

function endpointConflictResponse(
  auth: { setCookieHeader: string | null },
  currentUrl: string,
  desiredUrl: string,
): Response {
  const response = Response.json(
    {
      error: {
        code: "DISCORD_ENDPOINT_CONFLICT",
        message:
          "Discord interactions endpoint is already set to a different URL. Set forceOverwriteEndpoint=true to replace it.",
      },
      currentUrl,
      desiredUrl,
    },
    { status: 409 },
  );
  if (auth.setCookieHeader) {
    response.headers.append("Set-Cookie", auth.setCookieHeader);
  }
  return response;
}

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const meta = await getInitializedMeta();
    const state = await getPublicChannelState(request);
    const url = new URL(request.url);

    if (url.searchParams.get("diagnostics") === "1" && meta.channels.discord?.botToken) {
      const desiredEndpointUrl = buildDiscordPublicWebhookUrl(request);
      const diagnostics = await fetchDiscordApplicationIdentity(meta.channels.discord.botToken)
        .then((identity) => ({
          applicationId: identity.applicationId,
          currentEndpointUrl: identity.currentInteractionsEndpointUrl ?? null,
          desiredEndpointUrl,
          endpointDrift:
            (identity.currentInteractionsEndpointUrl ?? null) !== desiredEndpointUrl,
        }))
        .catch((error) => ({
          desiredEndpointUrl,
          error: error instanceof Error ? error.message : String(error),
        }));

      return authJsonOk({ ...state.discord, diagnostics }, auth);
    }

    return authJsonOk(state.discord, auth);
  } catch (error) {
    return authJsonError(error, auth);
  }
}

export async function PUT(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const connectability = await buildChannelConnectability("discord", request);
  if (!connectability.canConnect) {
    return buildChannelConnectBlockedResponse(auth, connectability);
  }

  try {
    const body = (await request.json()) as {
      botToken?: unknown;
      autoConfigureEndpoint?: unknown;
      autoRegisterCommand?: unknown;
      forceOverwriteEndpoint?: unknown;
    };
    const normalizedBotToken = normalizeBotToken(body.botToken);
    const autoConfigureEndpoint = parseOptionalBoolean(
      body.autoConfigureEndpoint,
      "autoConfigureEndpoint",
    );
    const autoRegisterCommand = parseOptionalBoolean(
      body.autoRegisterCommand,
      "autoRegisterCommand",
    );
    const forceOverwriteEndpoint = parseOptionalBoolean(
      body.forceOverwriteEndpoint,
      "forceOverwriteEndpoint",
    );

    const identity = await fetchDiscordApplicationIdentity(normalizedBotToken);
    const webhookUrl = buildDiscordPublicWebhookUrl(request);

    let updatedConfig: DiscordChannelConfig = {
      applicationId: identity.applicationId,
      publicKey: identity.publicKey,
      botToken: normalizedBotToken,
      configuredAt: Date.now(),
      appName: identity.appName,
      botUsername: identity.botUsername,
      endpointConfigured: false,
      endpointUrl: identity.currentInteractionsEndpointUrl ?? undefined,
      endpointError: undefined,
      commandRegistered: false,
      commandId: undefined,
      commandRegisteredAt: undefined,
    };

    if (autoConfigureEndpoint !== false) {
      const currentUrl = identity.currentInteractionsEndpointUrl ?? null;
      if (currentUrl && currentUrl !== webhookUrl && forceOverwriteEndpoint !== true) {
        return endpointConflictResponse(auth, currentUrl, webhookUrl);
      }

      try {
        await patchInteractionsEndpoint(normalizedBotToken, webhookUrl);
        updatedConfig = {
          ...updatedConfig,
          endpointConfigured: true,
          endpointUrl: webhookUrl,
        };
      } catch (error) {
        updatedConfig = {
          ...updatedConfig,
          endpointConfigured: false,
          endpointError: error instanceof Error ? error.message : String(error),
        };
      }
    }

    if (autoRegisterCommand !== false) {
      const command = await registerAskCommand(identity.applicationId, normalizedBotToken);
      updatedConfig = {
        ...updatedConfig,
        commandRegistered: true,
        commandId: command.commandId,
        commandRegisteredAt: Date.now(),
      };
    }

    await setDiscordChannelConfig(updatedConfig);
    const state = await getPublicChannelState(request);
    return authJsonOk(state.discord, auth);
  } catch (error) {
    return authJsonError(error, auth);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const meta = await getInitializedMeta();
    if (meta.channels.discord?.botToken) {
      try {
        await patchInteractionsEndpoint(meta.channels.discord.botToken, "");
      } catch {
        // Best-effort cleanup only.
      }
    }

    await setDiscordChannelConfig(null);
    const state = await getPublicChannelState(request);
    return authJsonOk(state.discord, auth);
  } catch (error) {
    return authJsonError(error, auth);
  }
}
