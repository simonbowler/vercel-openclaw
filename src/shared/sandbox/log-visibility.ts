import type { SingleStatus } from "@/shared/types";

/**
 * Returns true for lifecycle states where the sandbox has log files
 * that can be read: setup, booting, restoring, and running.
 *
 * Shared between the logs API route and the LogsPanel UI so the two
 * surfaces never drift apart on which states are log-readable.
 */
export function isSandboxLogReadableStatus(status: SingleStatus): boolean {
  return (
    status === "setup" ||
    status === "booting" ||
    status === "restoring" ||
    status === "running"
  );
}

/**
 * Full eligibility check: the status must be log-readable AND a
 * sandboxId must exist (otherwise there is nothing to tail).
 */
export function canReadSandboxLogs(
  status: SingleStatus,
  sandboxId: string | null,
): boolean {
  return Boolean(sandboxId) && isSandboxLogReadableStatus(status);
}

/**
 * Returns true for statuses where the sandbox is in a transitional
 * lifecycle phase (not yet running, not stopped/error).
 */
export function isSandboxLifecyclePending(status: SingleStatus): boolean {
  return (
    status === "creating" ||
    status === "setup" ||
    status === "booting" ||
    status === "restoring"
  );
}
