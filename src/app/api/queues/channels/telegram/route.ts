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
import { setWebhook } from "@/server/channels/telegram/bot-api";
import { logInfo, logError, logWarn } from "@/server/log";
import { getInitializedMeta, getStore } from "@/server/store/store";

const WEBHOOK_RECONCILE_KEY = "telegram:webhook:last-reconciled-at";
const WEBHOOK_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

async function reconcileTelegramWebhook(options?: {
  force?: boolean;
}): Promise<void> {
  const meta = await getInitializedMeta();
  const config = meta.channels.telegram;
  if (!config) return;

  if (!options?.force) {
    const store = getStore();
    const lastReconciledAt = await store.getValue<number>(WEBHOOK_RECONCILE_KEY);

    if (lastReconciledAt && Date.now() - lastReconciledAt < WEBHOOK_RECONCILE_INTERVAL_MS) {
      return;
    }
  }

  await setWebhook(config.botToken, config.webhookUrl, config.webhookSecret);
  await getStore().setValue(WEBHOOK_RECONCILE_KEY, Date.now());
  logInfo("channels.telegram_webhook_reconciled", {});
}

export const POST = handleCallback<QueuedChannelJob>(
  async (job, metadata) => {
    logInfo("channels.queue_consumer_received", {
      channel: "telegram",
      messageId: metadata.messageId,
      deliveryCount: metadata.deliveryCount,
      receivedAt: job.receivedAt,
    });

    try {
      await reconcileTelegramWebhook();
    } catch (err) {
      logWarn("channels.telegram_webhook_reconcile_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
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
      );
    } catch (error) {
      // Force webhook re-registration so Telegram resumes delivery
      // for future messages even if this one failed.
      void reconcileTelegramWebhook({ force: true }).catch((err) => {
        logWarn("channels.telegram_webhook_reconcile_on_error_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      throw error;
    }

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
