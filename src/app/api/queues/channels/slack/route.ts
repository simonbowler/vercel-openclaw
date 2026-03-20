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
import { createOperationContext, withOperationContext } from "@/server/observability/operation-context";

export const POST = handleCallback<QueuedChannelJob>(
  async (job, metadata) => {
    const op = createOperationContext({
      trigger: "channel.queue.consumer",
      reason: "channel:slack",
      requestId: job.requestId ?? null,
      channel: "slack",
      messageId: metadata.messageId,
      deliveryCount: metadata.deliveryCount,
      retryCount: job.retryCount ?? null,
      parentOpId: job.opId ?? null,
    });

    logInfo("channels.queue_consumer_received", withOperationContext(op, {
      receivedAt: job.receivedAt,
    }));

    await processChannelJob(
      {
        channel: "slack",
        getConfig: (meta) => meta.channels.slack,
        createAdapter: (config) => createSlackAdapter(config),
        sandboxReadyTimeoutMs: DEFAULT_CHANNEL_SANDBOX_READY_TIMEOUT_MS,
        requestTimeoutMs: DEFAULT_CHANNEL_REQUEST_TIMEOUT_MS,
      },
      job,
      op,
    );

    logInfo("channels.queue_consumer_success", withOperationContext(op));
  },
  {
    visibilityTimeoutSeconds: 600,
    retry: (error, metadata) =>
      buildQueueConsumerRetry("slack", error, metadata, isRetryable, logError),
  },
);
