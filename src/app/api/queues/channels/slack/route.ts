import { handleCallback } from "@vercel/queue";

import type { QueuedChannelJob } from "@/server/channels/driver";
import {
  processChannelJob,
  isRetryable,
  DEFAULT_CHANNEL_SANDBOX_READY_TIMEOUT_MS,
  DEFAULT_CHANNEL_REQUEST_TIMEOUT_MS,
} from "@/server/channels/driver";
import { buildQueueConsumerRetry } from "@/server/channels/queue";
import { createSlackAdapter } from "@/server/channels/slack/adapter";
import { logInfo, logError } from "@/server/log";

export const POST = handleCallback<QueuedChannelJob>(
  async (job, metadata) => {
    logInfo("channels.queue_consumer_received", {
      channel: "slack",
      messageId: metadata.messageId,
      deliveryCount: metadata.deliveryCount,
      receivedAt: job.receivedAt,
    });

    await processChannelJob(
      {
        channel: "slack",
        getConfig: (meta) => meta.channels.slack,
        createAdapter: (config) => createSlackAdapter(config),
        sandboxReadyTimeoutMs: DEFAULT_CHANNEL_SANDBOX_READY_TIMEOUT_MS,
        requestTimeoutMs: DEFAULT_CHANNEL_REQUEST_TIMEOUT_MS,
      },
      job,
    );

    logInfo("channels.queue_consumer_success", {
      channel: "slack",
      messageId: metadata.messageId,
    });
  },
  {
    visibilityTimeoutSeconds: 600,
    retry: (error, metadata) =>
      buildQueueConsumerRetry("slack", error, metadata, isRetryable, logError),
  },
);
