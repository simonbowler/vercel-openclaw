import { handleCallback } from "@vercel/queue";

import type { QueuedChannelJob } from "@/server/channels/driver";
import {
  processChannelJob,
  isRetryable,
  DEFAULT_CHANNEL_SANDBOX_READY_TIMEOUT_MS,
  DEFAULT_CHANNEL_REQUEST_TIMEOUT_MS,
} from "@/server/channels/driver";
import { buildQueueConsumerRetry } from "@/server/channels/queue";
import { createTelegramAdapter } from "@/server/channels/telegram/adapter";
import { logInfo, logError } from "@/server/log";

export const POST = handleCallback<QueuedChannelJob>(
  async (job, metadata) => {
    logInfo("channels.queue_consumer_received", {
      channel: "telegram",
      messageId: metadata.messageId,
      deliveryCount: metadata.deliveryCount,
      receivedAt: job.receivedAt,
    });

    await processChannelJob(
      {
        channel: "telegram",
        getConfig: (meta) => meta.channels.telegram,
        createAdapter: (config) => createTelegramAdapter(config),
        sandboxReadyTimeoutMs: DEFAULT_CHANNEL_SANDBOX_READY_TIMEOUT_MS,
        requestTimeoutMs: DEFAULT_CHANNEL_REQUEST_TIMEOUT_MS,
      },
      job,
    );

    logInfo("channels.queue_consumer_success", {
      channel: "telegram",
      messageId: metadata.messageId,
    });
  },
  {
    visibilityTimeoutSeconds: 600,
    retry: (error, metadata) =>
      buildQueueConsumerRetry("telegram", error, metadata, isRetryable, logError),
  },
);
