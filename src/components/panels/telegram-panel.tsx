import { useState } from "react";
import { ConfirmDialog, useConfirm } from "@/components/ui/confirm-dialog";
import { ConnectabilityNotice } from "@/components/panels/connectability-notice";
import type {
  RunAction,
  RequestJson,
  TelegramPreviewPayload,
  StatusPayload,
} from "@/components/admin-types";

type TelegramPanelProps = {
  status: StatusPayload;
  busy: boolean;
  runAction: RunAction;
  requestJson: RequestJson;
  refresh: () => Promise<void>;
};

export function TelegramPanel({
  status,
  busy,
  runAction,
  requestJson,
  refresh,
}: TelegramPanelProps) {
  const [botToken, setBotToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [preview, setPreview] = useState<TelegramPreviewPayload | null>(null);
  const [editing, setEditing] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [syncingCommands, setSyncingCommands] = useState(false);
  const { confirm, dialogProps } = useConfirm();

  const tg = status.channels.telegram;

  async function handlePreview(): Promise<void> {
    if (!botToken.trim()) return;
    setPanelError(null);
    const payload = await requestJson<TelegramPreviewPayload>(
      "/api/channels/telegram/preview",
      {
        label: "Preview Telegram bot",
        successMessage: "Telegram bot previewed",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ botToken: botToken.trim() }),
        refreshAfter: false,
      },
    );
    if (payload) {
      setPreview(payload);
    }
  }

  async function handleConnect(): Promise<void> {
    if (!botToken.trim()) return;
    setPanelError(null);
    try {
      await requestJson("/api/channels/telegram", {
        label: "Save Telegram",
        successMessage: "Telegram connected",
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ botToken: botToken.trim() }),
      });
      setBotToken("");
      setPreview(null);
      setEditing(false);
      setShowToken(false);
    } catch (error) {
      setPanelError(
        error instanceof Error ? error.message : "Failed to connect",
      );
    }
  }

  async function handleDisconnect(): Promise<void> {
    const ok = await confirm({
      title: "Disconnect Telegram?",
      description:
        "This will remove the bot token and stop processing messages from this Telegram bot.",
      confirmLabel: "Disconnect",
      variant: "danger",
    });
    if (!ok) return;

    setPanelError(null);
    try {
      await runAction("/api/channels/telegram", {
        label: "Disconnect Telegram",
        successMessage: "Telegram disconnected",
        method: "DELETE",
      });
      setEditing(false);
      setBotToken("");
      setPreview(null);
      setShowToken(false);
    } catch (error) {
      setPanelError(
        error instanceof Error ? error.message : "Failed to disconnect",
      );
    }
  }

  async function handleSyncCommands(): Promise<void> {
    setPanelError(null);
    setSyncingCommands(true);
    try {
      await runAction("/api/channels/telegram/sync-commands", {
        label: "Sync Telegram commands",
        successMessage: "Telegram commands synced",
        method: "POST",
      });
    } catch (error) {
      setPanelError(
        error instanceof Error ? error.message : "Failed to sync commands",
      );
    } finally {
      setSyncingCommands(false);
    }
  }

  return (
    <section className="channel-card channel-telegram">
      <div className="channel-head">
        <div>
          <h3>Telegram</h3>
          <p className="muted-copy">
            {tg.configured
              ? `Connected${tg.botUsername ? ` \u00b7 @${tg.botUsername}` : ""}`
              : "Not configured"}
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {tg.queueDepth > 0 && (
            <span className="channel-pill good">{tg.queueDepth} queued</span>
          )}
          <span
            className={`channel-pill ${
              tg.commandSyncStatus === "synced"
                ? "good"
                : tg.commandSyncStatus === "error"
                  ? "bad"
                  : ""
            }`}
          >
            {tg.commandSyncStatus === "synced"
              ? "commands synced"
              : tg.commandSyncStatus === "error"
                ? "command sync error"
                : "commands unsynced"}
          </span>
          <span
            className={`channel-pill ${
              tg.status === "connected"
                ? "good"
                : tg.status === "error"
                  ? "bad"
                  : ""
            }`}
          >
            {tg.status === "connected"
              ? "connected"
              : tg.status === "error"
                ? "error"
                : "offline"}
          </span>
        </div>
      </div>

      {panelError ? <p className="error-banner">{panelError}</p> : null}
      {tg.lastError ? <p className="error-banner">{tg.lastError}</p> : null}
      {tg.commandSyncError ? <p className="error-banner">{tg.commandSyncError}</p> : null}
      <ConnectabilityNotice connectability={tg.connectability} />

      {tg.configured && !editing ? (
        <div className="channel-connected-view">
          <div className="channel-detail-row">
            <span className="field-label">Bot</span>
            <code className="inline-code">
              @{tg.botUsername ?? "unknown"}
            </code>
          </div>
          <div className="channel-detail-row">
            <span className="field-label">Webhook URL</span>
            <code className="inline-code">{tg.webhookUrl ?? "\u2014"}</code>
          </div>
          <div className="channel-detail-row">
            <span className="field-label">Commands</span>
            <code className="inline-code">
              {tg.commandSyncStatus}
              {tg.commandsRegisteredAt
                ? ` \u00b7 ${new Date(tg.commandsRegisteredAt).toLocaleString()}`
                : ""}
            </code>
          </div>
          <div className="inline-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => {
                setPanelError(null);
                setEditing(true);
              }}
            >
              Update token
            </button>
            <button
              className="button secondary"
              disabled={busy || syncingCommands}
              onClick={() => void handleSyncCommands()}
            >
              {syncingCommands ? "Syncing\u2026" : "Sync commands"}
            </button>
            <button
              className="button ghost"
              disabled={busy}
              onClick={() => void handleDisconnect()}
            >
              Disconnect
            </button>
            <button
              className="button ghost"
              disabled={busy || refreshing}
              onClick={() => {
                setRefreshing(true);
                void refresh().finally(() => setRefreshing(false));
              }}
            >
              {refreshing ? "Refreshing\u2026" : "Refresh"}
            </button>
          </div>
        </div>
      ) : (
        <form className="channel-wizard" onSubmit={(e) => { e.preventDefault(); void handleConnect(); }}>
          <p className="channel-wizard-title">
            {editing ? "Update Bot Token" : "Connect Telegram Bot"}
          </p>

          {!editing && (
            <div className="channel-wizard-steps">
              <div className="channel-wizard-step">
                <span className="channel-step-number">1</span>
                <span className="muted-copy">
                  Open{" "}
                  <a
                    href="https://t.me/BotFather"
                    target="_blank"
                    rel="noreferrer"
                    className="channel-link"
                  >
                    @BotFather
                  </a>{" "}
                  on Telegram and create a bot with <code>/newbot</code>
                </span>
              </div>
              <div className="channel-wizard-step">
                <span className="channel-step-number">2</span>
                <span className="muted-copy">
                  Copy the bot token and paste it below
                </span>
              </div>
              <div className="channel-wizard-step">
                <span className="channel-step-number">3</span>
                <span className="muted-copy">
                  Click <strong>Preview bot</strong> to validate, then{" "}
                  <strong>Save &amp; Connect</strong>
                </span>
              </div>
            </div>
          )}

          <div className="stack">
            <span className="field-label">Bot token</span>
            <div className="channel-token-row">
              <input
                className="text-input"
                type={showToken ? "text" : "password"}
                value={botToken}
                onChange={(event) => {
                  setBotToken(event.target.value);
                  setPreview(null);
                }}
                placeholder="123456:ABC-DEF1234..."
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                data-form-type="other"
              />
              <button
                type="button"
                className="button ghost channel-toggle-btn"
                onClick={() => setShowToken((s) => !s)}
              >
                {showToken ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          {preview ? (
            <p className="success-copy">
              Bot preview: {preview.bot.first_name}
              {preview.bot.username ? ` (@${preview.bot.username})` : ""}
            </p>
          ) : null}

          <div className="inline-actions">
            <button
              type="button"
              className="button secondary"
              disabled={busy || !tg.connectability.canConnect || !botToken.trim()}
              onClick={() => void handlePreview()}
            >
              Preview bot
            </button>
            <button
              type="submit"
              className="button primary"
              disabled={busy || !tg.connectability.canConnect || !botToken.trim()}
            >
              {editing ? "Update" : "Save & Connect"}
            </button>
            {editing && (
              <button
                type="button"
                className="button ghost"
                onClick={() => {
                  setEditing(false);
                  setBotToken("");
                  setPreview(null);
                  setPanelError(null);
                  setShowToken(false);
                }}
              >
                Cancel
              </button>
            )}
          </div>
          {!tg.connectability.canConnect ? (
            <p className="muted-copy">
              Resolve the deployment blockers above before saving the Telegram bot token.
            </p>
          ) : null}
        </form>
      )}
      <ConfirmDialog {...dialogProps} />
    </section>
  );
}
