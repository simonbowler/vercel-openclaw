"use client";

import { StatusBadge } from "@/components/ui/badge";
import { ConfirmDialog, useConfirm } from "@/components/ui/confirm-dialog";
import {
  getFirstRunCallout,
  getLifecycleActionLabel,
} from "@/shared/sandbox-lifecycle-copy";
import type { CSSProperties } from "react";
import type {
  SetupProgress,
  StatusPayload,
  RunAction,
} from "@/components/admin-types";
import type { SingleStatus } from "@/shared/types";

type StatusPanelProps = {
  status: StatusPayload;
  statusVersion?: number;
  busy: boolean;
  pendingAction: string | null;
  runAction: RunAction;
  checkHealth: () => Promise<void>;
};

type LifecycleAwareStatus = StatusPayload & {
  lifecycle?: {
    restoreHistory?: unknown[];
  };
  snapshotHistory?: unknown[];
};

const NEEDS_RESTART = new Set<SingleStatus>(["error", "stopped", "uninitialized"]);
const IS_TRANSITIONAL = new Set<SingleStatus>([
  "creating",
  "restoring",
  "booting",
  "setup",
]);

const STEP_ORDER = [
  "Creating sandbox",
  "Installing OpenClaw",
  "Configuring",
  "Starting gateway",
  "Ready",
] as const;

function getSetupStepIndex(progress: SetupProgress | null): number {
  if (!progress) return 0;
  switch (progress.phase) {
    case "creating-sandbox":
      return 0;
    case "installing-openclaw":
    case "installing-bun":
    case "cleaning-cache":
    case "installing-plugin":
      return 1;
    case "writing-config":
    case "checking-version":
      return 2;
    case "starting-gateway":
    case "waiting-for-gateway":
    case "pairing-device":
    case "applying-firewall":
      return 3;
    case "ready":
      return 4;
    case "failed":
      return 3;
    default:
      return 0;
  }
}

function getStepStyle(
  index: number,
  activeIndex: number,
  failed: boolean,
): CSSProperties {
  if (failed && index === activeIndex) {
    return {
      borderColor: "var(--border-strong, rgba(255,255,255,0.24))",
      background: "var(--background-muted)",
      color: "var(--foreground)",
    };
  }
  if (index < activeIndex) {
    return {
      borderColor: "var(--border)",
      background: "var(--background-muted)",
      color: "var(--foreground-subtle, #a1a1aa)",
    };
  }
  if (index === activeIndex) {
    return {
      borderColor: "var(--border-strong, rgba(255,255,255,0.24))",
      background: "var(--background-muted)",
      color: "var(--foreground)",
    };
  }
  return {
    borderColor: "var(--border)",
    background: "var(--background)",
    color: "var(--foreground-muted)",
  };
}

function friendlyError(raw: string): { headline: string; detail: string } {
  const lower = raw.toLowerCase();
  if (lower.includes("gateway never became ready") || lower.includes("gateway_ready_timeout")) {
    return {
      headline: "Gateway didn't respond in time",
      detail: "This can happen after a deployment or token rotation. Restarting usually fixes it.",
    };
  }
  if (lower.includes("snapshot storage") || lower.includes("snapshot_not_found")) {
    return {
      headline: "Snapshot unavailable",
      detail: "The snapshot could not be loaded. Check your Upstash connection or create a new sandbox.",
    };
  }
  if (lower.includes("oidc") || lower.includes("token") || lower.includes("ai gateway")) {
    return {
      headline: "AI Gateway authentication failed",
      detail: "This usually resolves on the next attempt when a fresh token is issued.",
    };
  }
  if (lower.includes("command") && lower.includes("failed")) {
    return {
      headline: "A setup command failed during restore",
      detail: "The sandbox started but a configuration step failed. Restarting usually fixes it.",
    };
  }
  return {
    headline: "Sandbox encountered an error",
    detail: "An unexpected error occurred during the last operation.",
  };
}

function formatDurationMinutes(ms: number): string {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60_000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

function formatRelativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 5_000) return "just now";
  if (delta < 60_000) return `${Math.floor(delta / 1_000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

function formatGatewayStatus(status: StatusPayload["gatewayStatus"]): string {
  if (status === "ready") return "Ready";
  if (status === "not-ready") return "Not ready";
  return "Unknown";
}

export function getAutoSleepDisplay(
  status: Pick<StatusPayload, "timeoutSource">,
  displayedTimeoutMs: number | null,
): string {
  if (displayedTimeoutMs == null || status.timeoutSource === "none") {
    return "Unknown";
  }
  if (status.timeoutSource === "estimated" && displayedTimeoutMs <= 0) {
    return "Past estimated sleep time \u2014 sandbox may be asleep";
  }
  const suffix =
    status.timeoutSource === "estimated"
      ? " (estimated)"
      : status.timeoutSource === "live"
        ? " (live)"
        : "";
  return `${formatDurationMinutes(Math.max(displayedTimeoutMs, 0))}${suffix}`;
}

export function deriveEffectiveStatus(
  status: SingleStatus,
  timeoutRemainingMs: number | null,
  timeoutSource: string,
): SingleStatus | "asleep" {
  if (
    status === "running" &&
    timeoutSource === "estimated" &&
    timeoutRemainingMs != null &&
    timeoutRemainingMs <= 0
  ) {
    return "asleep";
  }
  return status;
}

export function StatusPanel({
  status,
  busy,
  pendingAction,
  runAction,
  checkHealth,
}: StatusPanelProps) {
  const { confirm: confirmStop, dialogProps: stopDialogProps } = useConfirm();

  const lifecycleStatus = status.status as SingleStatus;
  const effectiveStatus = deriveEffectiveStatus(
    lifecycleStatus,
    status.timeoutRemainingMs,
    status.timeoutSource,
  );
  const lifecycleAwareStatus = status as LifecycleAwareStatus;
  const hasSnapshot = Boolean(status.snapshotId);
  const restoreHistory = Array.isArray(
    lifecycleAwareStatus.lifecycle?.restoreHistory,
  )
    ? lifecycleAwareStatus.lifecycle.restoreHistory
    : [];
  const snapshotHistoryCount = Array.isArray(lifecycleAwareStatus.snapshotHistory)
    ? lifecycleAwareStatus.snapshotHistory.length
    : null;
  const isFirstRun =
    snapshotHistoryCount != null
      ? snapshotHistoryCount === 0
      : !hasSnapshot && restoreHistory.length === 0;
  const primaryActionLabel = getLifecycleActionLabel(
    effectiveStatus === "asleep" ? "stopped" : lifecycleStatus,
    hasSnapshot,
  );
  const firstRunCallout =
    lifecycleStatus === "uninitialized" ? getFirstRunCallout() : null;

  function handleRestart(): void {
    void runAction("/api/admin/ensure", {
      label: primaryActionLabel,
      successMessage:
        lifecycleStatus === "uninitialized"
          ? "Sandbox creation initiated"
          : lifecycleStatus === "stopped"
            ? "Sandbox start initiated"
            : hasSnapshot
              ? "Sandbox restore initiated"
              : "Fresh sandbox creation initiated",
      method: "POST",
    });
  }

  async function handleStop(): Promise<void> {
    const ok = await confirmStop({
      title: "Stop sandbox?",
      description:
        "This will snapshot the current state and stop the sandbox. You can restore it later from the snapshot.",
      confirmLabel: "Snapshot & stop",
      variant: "danger",
    });
    if (!ok) return;
    void runAction("/api/admin/stop", {
      label: "Stop sandbox",
      successMessage: "Sandbox stopped",
      method: "POST",
    });
  }

  const isStopping = pendingAction === "Stop sandbox";
  const displayStatus = isStopping ? "stopping" : effectiveStatus;
  const showRestart =
    NEEDS_RESTART.has(lifecycleStatus) || effectiveStatus === "asleep";
  const showRunningActions =
    lifecycleStatus === "running" &&
    effectiveStatus !== "asleep" &&
    !isStopping;
  const isLifecycleTransition = IS_TRANSITIONAL.has(lifecycleStatus);
  const isTransitional = isLifecycleTransition || isStopping;
  const errorCopy = status.lastError ? friendlyError(status.lastError) : null;
  const isCheckingHealth = pendingAction === "Check health";
  const setupProgress = status.setupProgress;
  const showSetupProgress = Boolean(setupProgress && isLifecycleTransition);
  const activeStepIndex = getSetupStepIndex(setupProgress);
  const setupFailed = setupProgress?.phase === "failed";

  return (
    <article className="panel-card">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Sandbox</p>
          <h2>Sandbox status</h2>
        </div>
        <StatusBadge status={displayStatus} />
      </div>

      <dl className="metrics-grid">
        <div>
          <dt>Sandbox ID</dt>
          <dd>{status.sandboxId ?? "none"}</dd>
        </div>
        <div>
          <dt>Snapshot</dt>
          <dd>{status.snapshotId ?? "none"}</dd>
        </div>
        <div>
          <dt>Auth mode</dt>
          <dd>{status.authMode}</dd>
        </div>
        <div>
          <dt>Store</dt>
          <dd>
            {status.storeBackend}
            {status.persistentStore ? "" : " (memory only)"}
          </dd>
        </div>
        <div>
          <dt>Gateway</dt>
          <dd>{formatGatewayStatus(status.gatewayStatus)}</dd>
          {status.gatewayCheckedAt != null ? (
            <p
              style={{
                margin: "4px 0 0",
                color: "var(--foreground-muted)",
                fontSize: 12,
                lineHeight: 1.4,
              }}
            >
              checked {formatRelativeTime(status.gatewayCheckedAt)}
            </p>
          ) : null}
        </div>
        <div>
          <dt>Sleep after</dt>
          <dd>{Math.round(status.sleepAfterMs / 60_000)}m</dd>
        </div>
        <div>
          <dt>Auto-sleep in</dt>
          <dd>{getAutoSleepDisplay(status, status.timeoutRemainingMs)}</dd>
        </div>
        <div>
          <dt>Firewall</dt>
          <dd>{status.firewall.mode}</dd>
        </div>
      </dl>

      {firstRunCallout ? (
        <div
          className="border border-zinc-800 bg-zinc-900/50 rounded-lg p-4"
          style={{
            marginTop: 20,
            border: "1px solid var(--border)",
            borderRadius: 12,
            background: "rgba(24, 24, 27, 0.5)",
            padding: 16,
          }}
        >
          <p style={{ margin: 0, fontWeight: 600 }}>{firstRunCallout.headline}</p>
          {firstRunCallout.body.map((line) => (
            <p
              key={line}
              style={{
                margin: "8px 0 0",
                color: "var(--foreground-muted)",
                lineHeight: 1.5,
              }}
            >
              {line}
            </p>
          ))}
        </div>
      ) : null}

      {showSetupProgress ? (
        <section
          style={{
            marginTop: 20,
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--background-elevated)",
            padding: 16,
          }}
        >
          <div
            style={{
              display: "grid",
              gap: 8,
            }}
          >
            <div
              aria-label="Setup steps"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
                gap: 8,
              }}
            >
              {STEP_ORDER.map((step, index) => (
                <div
                  key={step}
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    padding: "10px 8px",
                    fontSize: 12,
                    lineHeight: 1.4,
                    textAlign: "center",
                    ...getStepStyle(index, activeStepIndex, setupFailed),
                  }}
                >
                  {step}
                </div>
              ))}
            </div>

            <div>
              <p
                style={{
                  margin: 0,
                  fontSize: 12,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--foreground-muted)",
                }}
              >
                Current phase
              </p>
              <p style={{ margin: "6px 0 0", fontWeight: 600 }}>
                {setupProgress?.phaseLabel ?? "Starting setup"}
              </p>
              {setupProgress?.preview ? (
                <p
                  style={{
                    margin: "6px 0 0",
                    color: "var(--foreground-muted)",
                    fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
                    fontSize: 12,
                    lineHeight: 1.5,
                  }}
                >
                  {setupProgress.preview}
                </p>
              ) : null}
            </div>

            {setupProgress && setupProgress.lines.length > 0 ? (
              <details>
                <summary
                  style={{
                    cursor: "pointer",
                    color: "var(--foreground-muted)",
                    fontSize: 12,
                  }}
                >
                  Recent setup logs
                </summary>
                <pre
                  style={{
                    margin: "10px 0 0",
                    padding: 12,
                    borderRadius: 6,
                    background: "var(--background)",
                    border: "1px solid var(--border)",
                    color: "var(--foreground-muted)",
                    fontSize: 12,
                    lineHeight: 1.55,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
                  }}
                >
                  {setupProgress.lines
                    .map((line) => `[${line.stream}] ${line.text}`)
                    .join("\n")}
                </pre>
              </details>
            ) : null}
          </div>
        </section>
      ) : null}

      <div className="hero-actions" style={{ justifyContent: "flex-end" }}>
        {showRestart && (
          <button
            className="button success"
            disabled={busy}
            onClick={handleRestart}
          >
            {primaryActionLabel}
          </button>
        )}
        {showRunningActions && (
          <>
            <button
              className="button ghost"
              disabled={busy || isCheckingHealth}
              onClick={() => void checkHealth()}
              type="button"
            >
              {isCheckingHealth ? "Checking health\u2026" : "Check health"}
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => void handleStop()}
            >
              Stop
            </button>
            <a
              className="button success"
              href={status.gatewayUrl}
              target="_blank"
              rel="noreferrer"
            >
              {primaryActionLabel}
            </a>
          </>
        )}
        {isTransitional && (
          <button className="button ghost" disabled>
            {isStopping ? "Stopping\u2026" : "Starting\u2026"}
          </button>
        )}
      </div>


      {errorCopy ? (
        <div className="error-banner">
          <p style={{ margin: 0, fontWeight: 500 }}>
            {errorCopy.headline}
          </p>
          <p style={{ margin: "4px 0 0", opacity: 0.85 }}>
            {errorCopy.detail}
          </p>
          <details style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
            <summary>Technical details</summary>
            <pre style={{ margin: "4px 0 0", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
              {status.lastError}
            </pre>
          </details>
        </div>
      ) : null}

      <ConfirmDialog {...stopDialogProps} />
    </article>
  );
}
