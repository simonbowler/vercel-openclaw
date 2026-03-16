import {
  getAiGatewayAuthMode,
  getAuthMode,
  getStoreEnv,
  isVercelDeployment,
  requiresDurableStore,
} from "@/server/env";
import { isPublicUrl } from "@/server/channels/discord/application";
import { buildChannelPrerequisiteReport } from "@/server/channels/connectability";
import type { ChannelConnectability } from "@/shared/channel-connectability";
import {
  getWebhookBypassRequirement,
  getWebhookBypassStatusMessage,
} from "@/server/deploy-requirements";
import { logInfo } from "@/server/log";
import {
  getPublicUrlDiagnostics,
  resolvePublicOrigin,
  type BuiltPublicUrlDiagnostics,
  type PublicOriginResolution,
} from "@/server/public-url";

export type PreflightStatus = "pass" | "warn" | "fail";

export type PreflightCheckId =
  | "public-origin"
  | "webhook-bypass"
  | "store"
  | "ai-gateway"
  | "drain-recovery";

export type PreflightActionId =
  | "configure-public-origin"
  | "configure-webhook-bypass"
  | "configure-upstash"
  | "configure-ai-gateway-auth";

export type PreflightCheck = {
  id: PreflightCheckId;
  status: PreflightStatus;
  message: string;
};

export type PreflightAction = {
  id: PreflightActionId;
  status: "required" | "recommended";
  message: string;
  remediation: string;
  env: string[];
};

export type PreflightNextStep = {
  id: string;
  label: string;
  description: string;
};

export type PreflightWebhookDiagnostics = {
  slack: BuiltPublicUrlDiagnostics | null;
  telegram: BuiltPublicUrlDiagnostics | null;
  discord: (BuiltPublicUrlDiagnostics & { isPublic: boolean }) | null;
};

export type PreflightPayload = {
  ok: boolean;
  authMode: ReturnType<typeof getAuthMode>;
  publicOrigin: string | null;
  webhookBypassEnabled: boolean;
  webhookBypassRequired: boolean;
  storeBackend: "upstash" | "memory";
  aiGatewayAuth: "oidc" | "api-key" | "unavailable";
  cronSecretConfigured: boolean;
  publicOriginResolution: PublicOriginResolution | null;
  webhookDiagnostics: PreflightWebhookDiagnostics;
  channels: Record<"slack" | "telegram" | "discord", ChannelConnectability>;
  actions: PreflightAction[];
  checks: PreflightCheck[];
  nextSteps: PreflightNextStep[];
};

function buildWebhookDiagnostics(
  request: Request,
  publicOriginResolution: PublicOriginResolution | null,
): PreflightWebhookDiagnostics {
  if (!publicOriginResolution) {
    return { slack: null, telegram: null, discord: null };
  }

  const slack = getPublicUrlDiagnostics(
    "/api/channels/slack/webhook",
    request,
  );
  const telegram = getPublicUrlDiagnostics(
    "/api/channels/telegram/webhook",
    request,
  );
  const discordBase = getPublicUrlDiagnostics(
    "/api/channels/discord/webhook",
    request,
  );

  return {
    slack,
    telegram,
    discord: {
      ...discordBase,
      isPublic: isPublicUrl(discordBase.url),
    },
  };
}

function buildActions(input: {
  publicOriginResolution: PublicOriginResolution | null;
  webhookBypassEnabled: boolean;
  webhookBypassRequired: boolean;
  storeBackend: "upstash" | "memory";
  aiGatewayAuth: PreflightPayload["aiGatewayAuth"];
}): PreflightAction[] {
  const actions: PreflightAction[] = [];

  if (!input.publicOriginResolution) {
    actions.push({
      id: "configure-public-origin",
      status: "required",
      message:
        "Set NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_BASE_DOMAIN, or BASE_DOMAIN so webhook URLs and OAuth callbacks resolve to one canonical public origin.",
      remediation:
        "Deploy to Vercel to get a public URL automatically, or add NEXT_PUBLIC_APP_URL as an environment variable in your Vercel project settings.",
      env: ["NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_BASE_DOMAIN", "BASE_DOMAIN"],
    });
  }

  if (input.webhookBypassRequired && !input.webhookBypassEnabled) {
    actions.push({
      id: "configure-webhook-bypass",
      status: "required",
      message:
        "Enable Protection Bypass for Automation and set VERCEL_AUTOMATION_BYPASS_SECRET so Slack, Telegram, and Discord can reach the protected deployment.",
      remediation:
        "In your Vercel project, go to Settings > Deployment Protection > Protection Bypass for Automation. Enable it and copy the secret into the VERCEL_AUTOMATION_BYPASS_SECRET environment variable, then redeploy.",
      env: ["VERCEL_AUTOMATION_BYPASS_SECRET"],
    });
  }

  if (input.storeBackend === "memory") {
    const onVercel = isVercelDeployment();
    actions.push({
      id: "configure-upstash",
      status: onVercel ? "required" : "recommended",
      message: onVercel
        ? "Configure Upstash before connecting channels. Durable queue and metadata storage is required on Vercel deployments."
        : "Upstash is recommended for channel reliability. In-memory state is acceptable for local development.",
      remediation:
        "Add Upstash Redis from the Vercel Marketplace so the project receives UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
      env: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
    });
  }

  if (input.aiGatewayAuth === "unavailable") {
    actions.push({
      id: "configure-ai-gateway-auth",
      status: "required",
      message:
        "AI Gateway auth is unavailable. On Vercel this should come from OIDC; for local development provide AI_GATEWAY_API_KEY.",
      remediation:
        "On Vercel, OIDC tokens are provided automatically. If you see this on a Vercel deployment, redeploy the project. For local development, set AI_GATEWAY_API_KEY in your .env.local file.",
      env: ["AI_GATEWAY_API_KEY"],
    });
  }

  if (isVercelDeployment() && input.aiGatewayAuth === "api-key") {
    actions.push({
      id: "configure-ai-gateway-auth",
      status: "required",
      message:
        "This repo must authenticate to Vercel AI Gateway with OIDC on deployed Vercel environments.",
      remediation:
        "Remove AI_GATEWAY_API_KEY from the Vercel project settings and redeploy so the deployment uses its automatically-issued OIDC token.",
      env: ["AI_GATEWAY_API_KEY"],
    });
  }

  return actions;
}

function buildNextSteps(input: {
  ok: boolean;
  channels: Record<"slack" | "telegram" | "discord", ChannelConnectability>;
  actions: PreflightAction[];
}): PreflightNextStep[] {
  const steps: PreflightNextStep[] = [];

  if (!input.ok) {
    const requiredActions = input.actions.filter((a) => a.status === "required");
    if (requiredActions.length > 0) {
      steps.push({
        id: "resolve-blockers",
        label: "Resolve deployment blockers",
        description: `Fix ${requiredActions.length} required action${requiredActions.length > 1 ? "s" : ""} before connecting channels: ${requiredActions.map((a) => a.id).join(", ")}.`,
      });
    }
    return steps;
  }

  steps.push({
    id: "ensure-sandbox",
    label: "Start the sandbox",
    description:
      "Open the admin panel and click Ensure Running, or visit /gateway to auto-start the sandbox.",
  });

  const channelEntries = Object.entries(input.channels) as Array<
    ["slack" | "telegram" | "discord", ChannelConnectability]
  >;
  const connectable = channelEntries.filter(([, ch]) => ch.canConnect);

  if (connectable.length > 0) {
    steps.push({
      id: "connect-channels",
      label: "Connect a channel",
      description:
        "Go to the Channels tab in the admin panel. Each channel has a step-by-step wizard: Slack (paste signing secret + bot token), Telegram (paste bot token from @BotFather), Discord (paste bot token — endpoint and /ask command are configured automatically).",
    });
  }

  const recommendedActions = input.actions.filter(
    (a) => a.status === "recommended",
  );
  if (recommendedActions.length > 0) {
    steps.push({
      id: "recommended-setup",
      label: "Recommended improvements",
      description: recommendedActions.map((a) => a.message).join(" "),
    });
  }

  return steps;
}

export async function buildDeployPreflight(
  request: Request,
): Promise<PreflightPayload> {
  const authMode = getAuthMode();

  let publicOriginResolution: PublicOriginResolution | null = null;
  try {
    publicOriginResolution = resolvePublicOrigin(request);
  } catch {
    publicOriginResolution = null;
  }

  const publicOrigin = publicOriginResolution?.origin ?? null;
  const webhookBypassRequirement = getWebhookBypassRequirement();
  const webhookBypassEnabled = webhookBypassRequirement.configured;
  const storeBackend = getStoreEnv() ? "upstash" : "memory";

  const aiGatewayAuth = await getAiGatewayAuthMode();

  const cronSecretConfigured = Boolean(
    process.env.CRON_SECRET?.trim(),
  );
  const webhookDiagnostics = buildWebhookDiagnostics(
    request,
    publicOriginResolution,
  );

  const channels = await buildChannelPrerequisiteReport(request);

  const checks: PreflightCheck[] = [
    {
      id: "public-origin",
      status: publicOriginResolution ? "pass" : "fail",
      message: publicOriginResolution
        ? `Resolved public origin from ${publicOriginResolution.source}: ${publicOriginResolution.origin}`
        : "Could not resolve a canonical public origin. Set NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_BASE_DOMAIN, or BASE_DOMAIN.",
    },
    {
      id: "webhook-bypass",
      status:
        !webhookBypassRequirement.required || webhookBypassRequirement.configured
          ? "pass"
          : "fail",
      message: getWebhookBypassStatusMessage(webhookBypassRequirement),
    },
    {
      id: "store",
      status:
        storeBackend === "upstash"
          ? "pass"
          : requiresDurableStore()
            ? "fail"
            : "warn",
      message:
        storeBackend === "upstash"
          ? "Durable Upstash-backed state is configured."
          : requiresDurableStore()
            ? "Vercel deployments require Upstash. In-memory state loses queue data, credentials, and sandbox metadata on cold starts."
            : "Using in-memory state. Channel reliability requires Upstash in production.",
    },
    {
      id: "ai-gateway",
      status:
        aiGatewayAuth === "unavailable" ||
        (isVercelDeployment() && aiGatewayAuth !== "oidc")
          ? "fail"
          : "pass",
      message:
        aiGatewayAuth === "oidc"
          ? "AI Gateway will use a Vercel OIDC token."
          : aiGatewayAuth === "api-key"
            ? "AI Gateway is using AI_GATEWAY_API_KEY. This repo requires OIDC on Vercel deployments."
            : "No AI Gateway credential is available.",
    },
    {
      id: "drain-recovery",
      status: "pass",
      message: cronSecretConfigured
        ? "Channel delivery uses Vercel Queues as the primary mechanism. /api/cron/drain-channels is available as a diagnostic backstop."
        : "Channel delivery uses Vercel Queues as the primary mechanism. Set CRON_SECRET to enable /api/cron/drain-channels as an optional diagnostic backstop.",
    },
  ];

  const actions = buildActions({
    publicOriginResolution,
    webhookBypassEnabled,
    webhookBypassRequired: webhookBypassRequirement.required,
    storeBackend,
    aiGatewayAuth,
  });

  const ok =
    checks.every((check) => check.status !== "fail") &&
    Object.values(channels).every((ch) => ch.status !== "fail");

  const nextSteps = buildNextSteps({ ok, channels, actions });

  const payload: PreflightPayload = {
    ok,
    authMode,
    publicOrigin,
    webhookBypassEnabled,
    webhookBypassRequired: webhookBypassRequirement.required,
    storeBackend,
    aiGatewayAuth,
    cronSecretConfigured,
    publicOriginResolution,
    webhookDiagnostics,
    channels,
    actions,
    checks,
    nextSteps,
  };

  logInfo("deploy_preflight.built", {
    ok: payload.ok,
    authMode: payload.authMode,
    publicOrigin: payload.publicOrigin,
    webhookBypassEnabled: payload.webhookBypassEnabled,
    webhookBypassRequired: payload.webhookBypassRequired,
    storeBackend: payload.storeBackend,
    aiGatewayAuth: payload.aiGatewayAuth,
    cronSecretConfigured: payload.cronSecretConfigured,
    actionCount: payload.actions.length,
  });

  return payload;
}
