import type { SlackChannelConfig, TelegramChannelConfig, DiscordChannelConfig } from "@/shared/channels";
import type { ExtractedChannelMessage } from "@/server/channels/core/types";
import type { ChannelJobOptions, QueuedChannelJob } from "@/server/channels/driver";
import type { SlackExtractedMessage } from "@/server/channels/slack/adapter";
import type { TelegramExtractedMessage } from "@/server/channels/telegram/adapter";
import type { DiscordExtractedMessage } from "@/server/channels/discord/adapter";
import { extractTelegramChatId } from "@/server/channels/telegram/adapter";
import { deleteMessage } from "@/server/channels/telegram/bot-api";
import { logWarn } from "@/server/log";
import { getInitializedMeta } from "@/server/store/store";

export type DrainChannelWorkflowDependencies = {
  processChannelJob: typeof import("@/server/channels/driver").processChannelJob;
  isRetryable: typeof import("@/server/channels/driver").isRetryable;
  createSlackAdapter: typeof import("@/server/channels/slack/adapter").createSlackAdapter;
  createTelegramAdapter: typeof import("@/server/channels/telegram/adapter").createTelegramAdapter;
  createDiscordAdapter: typeof import("@/server/channels/discord/adapter").createDiscordAdapter;
  RetryableError: typeof import("workflow").RetryableError;
  FatalError: typeof import("workflow").FatalError;
};

type DrainChannelAdapterDependencies = Pick<
  DrainChannelWorkflowDependencies,
  "createSlackAdapter" | "createTelegramAdapter" | "createDiscordAdapter"
>;

type DrainChannelErrorDependencies = Pick<
  DrainChannelWorkflowDependencies,
  "FatalError" | "RetryableError" | "isRetryable"
>;

type SupportedChannelJobOptions =
  | ChannelJobOptions<SlackChannelConfig, unknown, SlackExtractedMessage>
  | ChannelJobOptions<TelegramChannelConfig, unknown, TelegramExtractedMessage>
  | ChannelJobOptions<DiscordChannelConfig, unknown, DiscordExtractedMessage>;

export async function drainChannelWorkflow(
  channel: string,
  payload: unknown,
  origin: string,
  requestId: string | null,
  bootMessageId?: number | null,
): Promise<void> {
  "use workflow";

  await processChannelStep(channel, payload, origin, requestId, bootMessageId ?? null);
}

export async function processChannelStep(
  channel: string,
  payload: unknown,
  origin: string,
  requestId: string | null,
  bootMessageId?: number | null,
  dependencies?: DrainChannelWorkflowDependencies,
): Promise<void> {
  "use step";

  const resolvedDependencies =
    dependencies ?? (await loadDrainChannelWorkflowDependencies());

  if (channel === "discord") {
    try {
      const { reconcileDiscordIntegration } = await import("@/server/channels/discord/reconcile");
      await reconcileDiscordIntegration();
    } catch (err) {
      const { logWarn } = await import("@/server/log");
      logWarn("channels.discord_integration_reconcile_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  try {
    const options = buildChannelJobOptions(channel, resolvedDependencies);
    const job = buildQueuedChannelJob(payload, origin, requestId);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await resolvedDependencies.processChannelJob(options as any, job);
  } catch (error) {
    throw toWorkflowProcessingError(channel, error, resolvedDependencies);
  } finally {
    // Clean up boot message sent from webhook route
    if (bootMessageId && channel === "telegram") {
      try {
        const meta = await getInitializedMeta();
        const tgConfig = meta.channels.telegram;
        if (tgConfig) {
          const chatId = extractTelegramChatId(payload);
          if (chatId) {
            await deleteMessage(tgConfig.botToken, Number(chatId), bootMessageId);
          }
        }
      } catch (cleanupError) {
        logWarn("channels.telegram_boot_message_cleanup_failed", {
          channel,
          bootMessageId,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
    }
  }
}

export function buildQueuedChannelJob(
  payload: unknown,
  origin: string,
  requestId: string | null,
): QueuedChannelJob<unknown> {
  return {
    payload,
    origin,
    receivedAt: Date.now(),
    requestId,
  };
}

// Workflows can run for up to 5 minutes — give the sandbox 2 minutes to
// restore instead of the old 25-second queue consumer timeout.
const WORKFLOW_SANDBOX_READY_TIMEOUT_MS = 120_000;

export function buildChannelJobOptions(
  channel: string,
  dependencies: DrainChannelAdapterDependencies,
): SupportedChannelJobOptions {
  switch (channel) {
    case "slack":
      return {
        channel: "slack",
        getConfig: (meta) => meta.channels.slack,
        createAdapter: (config: Parameters<typeof dependencies.createSlackAdapter>[0]) => dependencies.createSlackAdapter(config),
        sandboxReadyTimeoutMs: WORKFLOW_SANDBOX_READY_TIMEOUT_MS,
      };
    case "telegram":
      return {
        channel: "telegram",
        getConfig: (meta) => meta.channels.telegram,
        createAdapter: (config: Parameters<typeof dependencies.createTelegramAdapter>[0]) => dependencies.createTelegramAdapter(config),
        sandboxReadyTimeoutMs: WORKFLOW_SANDBOX_READY_TIMEOUT_MS,
      };
    case "discord":
      return {
        channel: "discord",
        getConfig: (meta) => meta.channels.discord,
        createAdapter: (config: Parameters<typeof dependencies.createDiscordAdapter>[0]) => dependencies.createDiscordAdapter(config),
        sandboxReadyTimeoutMs: WORKFLOW_SANDBOX_READY_TIMEOUT_MS,
      };
    default:
      throw new Error(`unsupported_channel:${channel}`);
  }
}

export function toWorkflowProcessingError(
  channel: string,
  error: unknown,
  dependencies: DrainChannelErrorDependencies,
): Error {
  const message = `drain_channel_workflow_failed:${channel}:${formatChannelError(error)}`;
  const errorMsg = formatChannelError(error);

  // Sandbox timeout should not be retried — the sandbox lifecycle handles
  // its own retry internally. Retrying the step just burns time re-polling.
  if (errorMsg.includes("sandbox_not_ready") || errorMsg.includes("SANDBOX_READY_TIMEOUT")) {
    return new dependencies.FatalError(message);
  }

  if (dependencies.isRetryable(error)) {
    return new dependencies.RetryableError(message, {
      retryAfter: "15s",
    });
  }

  return new dependencies.FatalError(message);
}

async function loadDrainChannelWorkflowDependencies(): Promise<DrainChannelWorkflowDependencies> {
  const [
    { processChannelJob, isRetryable },
    { createSlackAdapter },
    { createTelegramAdapter },
    { createDiscordAdapter },
    { RetryableError, FatalError },
  ] = await Promise.all([
    import("@/server/channels/driver"),
    import("@/server/channels/slack/adapter"),
    import("@/server/channels/telegram/adapter"),
    import("@/server/channels/discord/adapter"),
    import("workflow"),
  ]);

  return {
    processChannelJob,
    isRetryable,
    createSlackAdapter,
    createTelegramAdapter,
    createDiscordAdapter,
    RetryableError,
    FatalError,
  };
}

function formatChannelError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.length > 0) {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
