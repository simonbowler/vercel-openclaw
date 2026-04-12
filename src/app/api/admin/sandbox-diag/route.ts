import { getSandboxController } from "@/server/sandbox/controller";
import { ApiError, jsonError } from "@/shared/http";
import { requireJsonRouteAuth, authJsonOk } from "@/server/auth/route-auth";
import { getInitializedMeta } from "@/server/store/store";

const COMMAND_TIMEOUT_MS = 10_000;

export type PortCheck = {
  port: number;
  label: string;
  status: "ok" | "warn" | "fail" | "unchecked";
  httpStatus: number | null;
  message: string;
  tip: string | null;
};

export type SandboxDiagPayload = {
  sandboxStatus: string;
  openclawVersion: string | null;
  ports: PortCheck[];
  providerDiscoveryFiltered: boolean;
  checkedAt: number;
};

function buildPortCheckCommand(): string {
  // Single shell command that checks all ports and returns JSON.
  // Each curl gets a 3-second max-time to avoid blocking.
  return [
    'OC_VERSION=$(openclaw --version 2>/dev/null || echo "")',
    'GW=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://127.0.0.1:3000/ 2>/dev/null || echo "000")',
    'TG=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 -X POST -H "Content-Type: application/json" -d \'{"probe":true}\' http://127.0.0.1:8787/telegram-webhook 2>/dev/null || echo "000")',
    'SLACK=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 -X POST http://127.0.0.1:3000/slack/events 2>/dev/null || echo "000")',
    'AIGW=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 https://ai-gateway.vercel.sh/v1/models 2>/dev/null || echo "000")',
    'PROV="${OPENCLAW_TEST_ONLY_PROVIDER_PLUGIN_IDS:-}"',
    'printf \'{"oc":"%s","gw":"%s","tg":"%s","slack":"%s","aigw":"%s","prov":"%s"}\\n\' "$OC_VERSION" "$GW" "$TG" "$SLACK" "$AIGW" "$PROV"',
  ].join(" && ");
}

function parseGatewayPort(httpStatus: number): PortCheck {
  if (httpStatus === 200) {
    return {
      port: 3000,
      label: "Gateway",
      status: "ok",
      httpStatus,
      message: "Responding",
      tip: null,
    };
  }
  if (httpStatus === 0) {
    return {
      port: 3000,
      label: "Gateway",
      status: "fail",
      httpStatus: null,
      message: "Not listening",
      tip: "The gateway process may not have started. Check the admin logs for startup errors.",
    };
  }
  return {
    port: 3000,
    label: "Gateway",
    status: "warn",
    httpStatus,
    message: `HTTP ${httpStatus}`,
    tip: null,
  };
}

function parseTelegramPort(httpStatus: number): PortCheck {
  if (httpStatus === 401) {
    return {
      port: 8787,
      label: "Telegram",
      status: "ok",
      httpStatus,
      message: "Handler registered",
      tip: null,
    };
  }
  if (httpStatus === 200) {
    return {
      port: 8787,
      label: "Telegram",
      status: "warn",
      httpStatus,
      message: "Handler not registered yet",
      tip: "The Telegram webhook handler hasn't finished starting. Messages sent now may be silently dropped. This usually resolves within 30 seconds after boot.",
    };
  }
  if (httpStatus === 0) {
    return {
      port: 8787,
      label: "Telegram",
      status: "fail",
      httpStatus: null,
      message: "Not listening",
      tip: "Port 8787 is not open. The gateway may still be starting, or Telegram is not configured.",
    };
  }
  return {
    port: 8787,
    label: "Telegram",
    status: "warn",
    httpStatus,
    message: `HTTP ${httpStatus}`,
    tip: null,
  };
}

function parseSlackPort(httpStatus: number): PortCheck {
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      port: 3000,
      label: "Slack",
      status: "ok",
      httpStatus,
      message: "Handler registered",
      tip: null,
    };
  }
  if (httpStatus === 404) {
    return {
      port: 3000,
      label: "Slack",
      status: "warn",
      httpStatus,
      message: "Handler not registered yet",
      tip: "The Slack webhook route hasn't been registered. The gateway may still be starting channels.",
    };
  }
  if (httpStatus === 0) {
    return {
      port: 3000,
      label: "Slack",
      status: "fail",
      httpStatus: null,
      message: "Gateway not reachable",
      tip: null,
    };
  }
  return {
    port: 3000,
    label: "Slack",
    status: "ok",
    httpStatus,
    message: `HTTP ${httpStatus}`,
    tip: null,
  };
}

function parseAiGateway(httpStatus: number): PortCheck {
  if (httpStatus === 200) {
    return {
      port: 443,
      label: "AI Gateway",
      status: "ok",
      httpStatus,
      message: "Reachable",
      tip: null,
    };
  }
  if (httpStatus === 0) {
    return {
      port: 443,
      label: "AI Gateway",
      status: "fail",
      httpStatus: null,
      message: "Unreachable",
      tip: "The AI Gateway is not reachable from inside the sandbox. Check the firewall network policy.",
    };
  }
  return {
    port: 443,
    label: "AI Gateway",
    status: "warn",
    httpStatus,
    message: `HTTP ${httpStatus}`,
    tip: null,
  };
}

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const meta = await getInitializedMeta();

  if (meta.status !== "running" || !meta.sandboxId) {
    return authJsonOk(
      {
        sandboxStatus: meta.status,
        openclawVersion: null,
        ports: [],
        providerDiscoveryFiltered: false,
        checkedAt: Date.now(),
      } satisfies SandboxDiagPayload,
      auth,
    );
  }

  try {
    const sandbox = await getSandboxController().get({ sandboxId: meta.sandboxId });
    const signal = AbortSignal.timeout(COMMAND_TIMEOUT_MS);
    const result = await sandbox.runCommand("sh", ["-c", buildPortCheckCommand()], { signal });
    const stdout = await result.output("stdout");

    let parsed: {
      oc: string;
      gw: string;
      tg: string;
      slack: string;
      aigw: string;
      prov: string;
    };
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      return jsonError(
        new ApiError(502, "DIAG_PARSE_ERROR", `Failed to parse diagnostic output: ${stdout.slice(0, 200)}`),
      );
    }

    const gwStatus = Number.parseInt(parsed.gw, 10) || 0;
    const tgStatus = Number.parseInt(parsed.tg, 10) || 0;
    const slackStatus = Number.parseInt(parsed.slack, 10) || 0;
    const aigwStatus = Number.parseInt(parsed.aigw, 10) || 0;

    const ports: PortCheck[] = [
      parseGatewayPort(gwStatus),
      parseTelegramPort(tgStatus),
      parseSlackPort(slackStatus),
      parseAiGateway(aigwStatus),
    ];

    return authJsonOk(
      {
        sandboxStatus: meta.status,
        openclawVersion: parsed.oc || null,
        ports,
        providerDiscoveryFiltered: Boolean(parsed.prov),
        checkedAt: Date.now(),
      } satisfies SandboxDiagPayload,
      auth,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      return jsonError(
        new ApiError(408, "DIAG_TIMEOUT", "Sandbox diagnostics timed out."),
      );
    }
    return jsonError(error);
  }
}
