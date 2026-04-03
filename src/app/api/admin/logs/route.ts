import { getSandboxController } from "@/server/sandbox/controller";

import type { LogEntry, LogLevel, LogSource } from "@/shared/types";
import { requireJsonRouteAuth, authJsonOk } from "@/server/auth/route-auth";
import {
  filterLogEntries,
  getFilteredServerLogs,
  logDebug,
  logWarn,
  type LogFilters,
} from "@/server/log";
import { getInitializedMeta } from "@/server/store/store";
import { canReadSandboxLogs } from "@/shared/sandbox/log-visibility";
import { isChannelName } from "@/shared/channels";

const MAX_LOG_LINES = 200;
const LOG_FILE_GLOB = "/tmp/openclaw/openclaw-*.log";

/**
 * Parse a raw log line into a structured LogEntry.
 * Expected format: JSON lines with ts/level/msg/ctx, or plain text fallback.
 */
function parseLogLine(line: string, index: number): LogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as {
      ts?: string;
      level?: string;
      msg?: string;
      source?: string;
      ctx?: Record<string, unknown>;
    };

    const level = normalizeLevel(parsed.level);
    const data = parsed.ctx && Object.keys(parsed.ctx).length > 0
      ? parsed.ctx
      : undefined;
    return {
      id: `log-${parsed.ts ?? index}-${index}`,
      timestamp: parsed.ts ? new Date(parsed.ts).getTime() : 0,
      timestampKind: parsed.ts ? "exact" : "untimed",
      sourceOrder: index,
      level,
      source: normalizeSource(parsed.source, parsed.ctx?.source),
      message: parsed.msg ?? trimmed,
      ...(data ? { data } : {}),
    };
  } catch {
    // Plain text line — treat as info
    return {
      id: `log-plain-${index}`,
      timestamp: 0,
      timestampKind: "untimed",
      sourceOrder: index,
      level: "info",
      source: "system",
      message: trimmed,
    };
  }
}

function normalizeLevel(raw: unknown): LogLevel {
  if (raw === "error" || raw === "warn" || raw === "info" || raw === "debug") {
    return raw;
  }
  return "info";
}

function parseSource(raw: unknown): LogSource | null {
  const valid: LogSource[] = [
    "lifecycle",
    "proxy",
    "firewall",
    "channels",
    "auth",
    "system",
  ];
  if (typeof raw === "string" && valid.includes(raw as LogSource)) {
    return raw as LogSource;
  }
  return null;
}

function normalizeSource(primary: unknown, fallback?: unknown): LogSource {
  return parseSource(primary) ?? parseSource(fallback) ?? "system";
}

function isValidLevel(value: string): value is LogLevel {
  return value === "error" || value === "warn" || value === "info" || value === "debug";
}

function isValidSource(value: string): value is LogSource {
  const valid = ["lifecycle", "proxy", "firewall", "channels", "auth", "system"];
  return valid.includes(value);
}

/**
 * Detect `tail` header lines emitted when multiple files match the glob.
 * These have the form `==> /path/to/file <==` and should be excluded.
 */
function isTailHeaderLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("==> ") && trimmed.endsWith(" <==");
}

/**
 * Sort log entries: exact-timestamped entries by time descending,
 * untimed entries by source order descending, untimed entries sort after exact.
 */
function compareLogEntries(a: LogEntry, b: LogEntry): number {
  const aUntimed = a.timestampKind === "untimed";
  const bUntimed = b.timestampKind === "untimed";

  if (aUntimed && bUntimed) {
    return (b.sourceOrder ?? 0) - (a.sourceOrder ?? 0);
  }
  if (aUntimed !== bUntimed) {
    return aUntimed ? 1 : -1;
  }
  return b.timestamp - a.timestamp;
}

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const url = new URL(request.url);
  const levelParam = url.searchParams.get("level") ?? undefined;
  const sourceParam = url.searchParams.get("source") ?? undefined;
  const searchParam = url.searchParams.get("search") ?? undefined;
  const opIdParam = url.searchParams.get("opId") ?? undefined;
  const requestIdParam = url.searchParams.get("requestId") ?? undefined;
  const channelParam = url.searchParams.get("channel") ?? undefined;
  const sandboxIdParam = url.searchParams.get("sandboxId") ?? undefined;
  const messageIdParam = url.searchParams.get("messageId") ?? undefined;

  const level = levelParam && isValidLevel(levelParam) ? levelParam : undefined;
  const source = sourceParam && isValidSource(sourceParam) ? sourceParam : undefined;
  const channel =
    channelParam && isChannelName(channelParam) ? channelParam : undefined;

  const filters: LogFilters = {
    level,
    source,
    search: searchParam,
    opId: opIdParam,
    requestId: requestIdParam,
    channel,
    sandboxId: sandboxIdParam,
    messageId: messageIdParam,
  };

  // Collect server-side structured logs from the ring buffer
  const serverLogs = getFilteredServerLogs(filters);

  // Collect sandbox logs when the sandbox exists and is in an active state
  const meta = await getInitializedMeta();

  const diagnostics = {
    sandbox: {
      attempted: false,
      included: false,
      status: meta.status,
      sandboxId: meta.sandboxId,
      tailError: null as string | null,
      parsedLineCount: 0,
      matchedLineCount: 0,
      untimedLineCount: 0,
    },
    filters,
  };

  let sandboxLogs: LogEntry[] = [];
  if (canReadSandboxLogs(meta.status, meta.sandboxId)) {
    diagnostics.sandbox.attempted = true;

    try {
      const sandbox = await getSandboxController().get({ sandboxId: meta.sandboxId! });
      const result = await sandbox.runCommand("bash", [
        "-c",
        `tail -q -n ${MAX_LOG_LINES} ${LOG_FILE_GLOB} 2>/dev/null || echo ""`,
      ]);

      const stdout = await result.output("stdout");
      const parsed: LogEntry[] = [];

      for (const [index, line] of stdout.split("\n").entries()) {
        if (isTailHeaderLine(line)) continue;
        const entry = parseLogLine(line, index);
        if (!entry) continue;
        if (entry.timestampKind === "untimed") {
          diagnostics.sandbox.untimedLineCount += 1;
        }
        parsed.push(entry);
      }

      diagnostics.sandbox.included = true;
      diagnostics.sandbox.parsedLineCount = parsed.length;

      if (diagnostics.sandbox.untimedLineCount > 0) {
        logDebug("admin.logs.untimed_lines_present", {
          sandboxId: meta.sandboxId,
          untimedLineCount: diagnostics.sandbox.untimedLineCount,
        });
      }

      sandboxLogs = filterLogEntries(parsed, filters);
      diagnostics.sandbox.matchedLineCount = sandboxLogs.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.sandbox.tailError = message;

      logWarn("admin.logs.sandbox_tail_failed", {
        sandboxId: meta.sandboxId,
        status: meta.status,
        error: message,
      });
      sandboxLogs = [];
    }
  }

  // Merge and sort: exact timestamps by time descending, untimed entries last in source order
  const allLogs = [...serverLogs, ...sandboxLogs].sort(compareLogEntries);

  return authJsonOk(
    {
      logs: allLogs,
      diagnostics: {
        serverLogCount: serverLogs.length,
        sandboxLogCount: sandboxLogs.length,
        totalLogCount: allLogs.length,
        ...diagnostics,
      },
    },
    auth,
  );
}
