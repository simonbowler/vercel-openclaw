import { handleCallback } from "@vercel/queue";

import type { QueuedChannelJob } from "@/server/channels/driver";
import {
  processChannelJob,
  isRetryable,
  DEFAULT_CHANNEL_SANDBOX_READY_TIMEOUT_MS,
  DEFAULT_CHANNEL_REQUEST_TIMEOUT_MS,
} from "@/server/channels/driver";
import { buildQueueConsumerRetry } from "@/server/channels/queue";
import { reconcileTelegramIntegration } from "@/server/channels/telegram/reconcile";
import { createTelegramAdapter } from "@/server/channels/telegram/adapter";
import { logInfo, logError, logWarn } from "@/server/log";
import { createOperationContext, withOperationContext } from "@/server/observability/operation-context";

export const POST = handleCallback<QueuedChannelJob>(
  async (job, metadata) => {
    const op = createOperationContext({
      trigger: "channel.queue.consumer",
      reason: "channel:telegram",
      requestId: job.requestId ?? null,
      channel: "telegram",
      messageId: metadata.messageId,
      deliveryCount: metadata.deliveryCount,
      retryCount: job.retryCount ?? null,
      parentOpId: job.opId ?? null,
    });

    logInfo("channels.queue_consumer_received", withOperationContext(op, {
      receivedAt: job.receivedAt,
    }));

    try {
      await reconcileTelegramIntegration();
    } catch (err) {
      logWarn("channels.telegram_integration_reconcile_failed", withOperationContext(op, {
        error: err instanceof Error ? err.message : String(err),
      }));
    }

    try {
      await processChannelJob(
        {
          channel: "telegram",
          getConfig: (meta) => meta.channels.telegram,
          createAdapter: (config) => createTelegramAdapter(config),
          sandboxReadyTimeoutMs: DEFAULT_CHANNEL_SANDBOX_READY_TIMEOUT_MS,
          requestTimeoutMs: DEFAULT_CHANNEL_REQUEST_TIMEOUT_MS,
        },
        job,
        op,
      );
    } catch (error) {
      void reconcileTelegramIntegration({ force: true }).catch((err) => {
        logWarn("channels.telegram_reconcile_on_error_failed", withOperationContext(op, {
          error: err instanceof Error ? err.message : String(err),
        }));
      });
      throw error;
    }

    logInfo("channels.queue_consumer_success", withOperationContext(op));
  },
  {
    visibilityTimeoutSeconds: 600,
    retry: (error, metadata) =>
      buildQueueConsumerRetry("telegram", error, metadata, isRetryable, logError),
  },
);
