import type { ChannelConnectability } from "@/shared/channel-connectability";

export type PublicSlackState = {
  configured: boolean;
  webhookUrl: string;
  configuredAt: number | null;
  team: string | null;
  user: string | null;
  botId: string | null;
  hasSigningSecret: boolean;
  hasBotToken: boolean;
  lastError: string | null;
  connectability: ChannelConnectability;
};

export type PublicTelegramState = {
  configured: boolean;
  webhookUrl: string | null;
  botUsername: string | null;
  configuredAt: number | null;
  lastError: string | null;
  status: "connected" | "disconnected" | "error";
  commandSyncStatus: "synced" | "unsynced" | "error";
  commandsRegisteredAt: number | null;
  commandSyncError: string | null;
  connectability: ChannelConnectability;
};

export type PublicDiscordState = {
  configured: boolean;
  webhookUrl: string;
  applicationId: string | null;
  publicKey: string | null;
  configuredAt: number | null;
  appName: string | null;
  botUsername: string | null;
  endpointConfigured: boolean;
  endpointUrl: string | null;
  endpointError: string | null;
  commandRegistered: boolean;
  commandId: string | null;
  inviteUrl: string | null;
  isPublicUrl: boolean;
  connectability: ChannelConnectability;
};

export type PublicChannelState = {
  slack: PublicSlackState;
  telegram: PublicTelegramState;
  discord: PublicDiscordState;
};
