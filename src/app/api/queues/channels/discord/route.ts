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
import { logInfo, logError } from "@/server/log";

export const POST = handleCallback<QueuedChannelJob>(
  async (job, metadata) => {
    logInfo("channels.queue_consumer_received", {
      channel: "discord",
      messageId: metadata.messageId,
      deliveryCount: metadata.deliveryCount,
      receivedAt: job.receivedAt,
    });

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
