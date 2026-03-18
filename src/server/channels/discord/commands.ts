import { getChannelCommandDefinitions } from "@/shared/channel-commands";

const DISCORD_API_BASE = "https://discord.com/api/v10";

export async function registerAskCommand(
  applicationId: string,
  botToken: string,
  fetchFn?: typeof fetch,
): Promise<{ commandId?: string }> {
  const fetcher = fetchFn ?? globalThis.fetch;
  if (typeof fetcher !== "function") {
    throw new Error("Fetch is unavailable in this runtime");
  }

  const askCommand = getChannelCommandDefinitions().find(
    (command) => command.name === "ask" && command.discord,
  );
  if (!askCommand?.discord) {
    throw new Error("Shared /ask Discord command definition is missing");
  }

  const normalizedToken = botToken.trim().replace(/^Bot\s+/i, "").trim();
  const response = await fetcher(
    `${DISCORD_API_BASE}/applications/${encodeURIComponent(applicationId)}/commands`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${normalizedToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: askCommand.name,
        description: askCommand.description,
        type: askCommand.discord.type,
        options: askCommand.discord.options,
      }),
    },
  );

  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    throw new Error(
      `Discord command registration failed with status ${response.status}: ${body}`,
    );
  }

  const payload = (await response.json()) as Record<string, unknown>;
  return {
    commandId: typeof payload.id === "string" ? payload.id : undefined,
  };
}
