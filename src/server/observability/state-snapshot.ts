import type { ChannelName } from "@/shared/channels";
import type {
  LogLevel,
  OperationContext,
  QueueStateSnapshot,
  SingleMeta,
} from "@/shared/types";
import { log } from "@/server/log";
import { withOperationContext } from "@/server/observability/operation-context";

export type StateSnapshotInput = {
  event: string;
  meta: Pick<
    SingleMeta,
    "status" | "sandboxId" | "snapshotId" | "lastError" | "updatedAt" | "lastAccessedAt"
  >;
  op?: OperationContext;
  level?: LogLevel;
  channel?: ChannelName;
  queue?: QueueStateSnapshot | null;
  extra?: Record<string, unknown>;
};

export function buildStateSnapshotData(
  input: StateSnapshotInput,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    status: input.meta.status,
    sandboxId: input.meta.sandboxId,
    snapshotId: input.meta.snapshotId,
    lastError: input.meta.lastError,
    updatedAt: input.meta.updatedAt,
    lastAccessedAt: input.meta.lastAccessedAt,
  };

  if (input.channel) out.channel = input.channel;
  if (input.queue) {
    out.queueQueued = input.queue.queued;
    out.queueProcessing = input.queue.processing;
  }

  if (input.extra) {
    for (const [key, value] of Object.entries(input.extra)) {
      if (value !== undefined && value !== null) {
        out[key] = value;
      }
    }
  }

  return out;
}

export function logStateSnapshot(input: StateSnapshotInput): void {
  const data = buildStateSnapshotData(input);
  const ctx = input.op ? withOperationContext(input.op, data) : data;
  log(input.level ?? "info", input.event, ctx);
}
