import { handleCallback } from "@vercel/queue";

import type { QueuedChannelJob } from "@/server/channels/driver";
import {
  processChannelJob,
  isRetryable,
  DEFAULT_CHANNEL_SANDBOX_READY_TIMEOUT_MS,
  DEFAULT_CHANNEL_REQUEST_TIMEOUT_MS,
} from "@/server/channels/driver";
import { buildQueueConsumerRetry } from "@/server/channels/queue";
import { createDiscordAdapter } from "@/server/channels/discord/adapter";
import { reconcileDiscordIntegration } from "@/server/channels/discord/reconcile";
import { logInfo, logError, logWarn } from "@/server/log";

export const POST = handleCallback<QueuedChannelJob>(
  async (job, metadata) => {
    logInfo("channels.queue_consumer_received", {
      channel: "discord",
      messageId: metadata.messageId,
      deliveryCount: metadata.deliveryCount,
      receivedAt: job.receivedAt,
    });

    try {
      await reconcileDiscordIntegration({
        request: new Request(job.origin),
      });
    } catch (err) {
      logWarn("channels.discord_reconcile_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      await processChannelJob(
        {
          channel: "discord",
          getConfig: (meta) => meta.channels.discord,
          createAdapter: (config) => createDiscordAdapter(config),
          sandboxReadyTimeoutMs: DEFAULT_CHANNEL_SANDBOX_READY_TIMEOUT_MS,
          requestTimeoutMs: DEFAULT_CHANNEL_REQUEST_TIMEOUT_MS,
        },
        job,
      );
    } catch (error) {
      void reconcileDiscordIntegration({
        request: new Request(job.origin),
        force: true,
      }).catch((err) => {
        logWarn("channels.discord_reconcile_on_error_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      throw error;
    }

    logInfo("channels.queue_consumer_success", {
      channel: "discord",
      messageId: metadata.messageId,
    });
  },
  {
    visibilityTimeoutSeconds: 600,
    retry: (error, metadata) =>
      buildQueueConsumerRetry("discord", error, metadata, isRetryable, logError),
  },
);
