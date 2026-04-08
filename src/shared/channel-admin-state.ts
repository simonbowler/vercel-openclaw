import type { ChannelConnectability } from "@/shared/channel-connectability";
import type { ChannelMode } from "@/shared/channels";
import type { WhatsAppLinkState } from "@/shared/channels";

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
  /** "oauth" when SLACK_CLIENT_ID/SECRET/SIGNING_SECRET env vars are set, "manual" otherwise. */
  installMethod: "oauth" | "manual";
  /** Install route URL when OAuth mode is available. */
  installUrl: string | null;
  /** True when all three Slack app env vars are configured. */
  appCredentialsConfigured: boolean;
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

export type PublicWhatsAppState = {
  configured: boolean;
  mode: ChannelMode;
  webhookUrl: string | null;
  status: WhatsAppLinkState;
  configuredAt: number | null;
  displayName: string | null;
  linkedPhone: string | null;
  lastError: string | null;
  requiresRunningSandbox: boolean;
  loginVia: string;
  connectability: ChannelConnectability;
};

export type PublicChannelState = {
  slack: PublicSlackState;
  telegram: PublicTelegramState;
  discord: PublicDiscordState;
  whatsapp: PublicWhatsAppState;
};
