import { getAuthMode } from "@/server/env";
import { getProtectionBypassSecret } from "@/server/public-url";

export type WebhookBypassRequirementReason =
  | "sign-in-with-vercel"
  | "local-or-non-vercel"
  | "protected-vercel";

export type WebhookBypassRequirement = {
  required: boolean;
  configured: boolean;
  reason: WebhookBypassRequirementReason;
};

export function getWebhookBypassRequirement(): WebhookBypassRequirement {
  const configured = Boolean(getProtectionBypassSecret());

  if (getAuthMode() !== "deployment-protection") {
    return {
      required: false,
      configured,
      reason: "sign-in-with-vercel",
    };
  }

  if (process.env.VERCEL !== "1") {
    return {
      required: false,
      configured,
      reason: "local-or-non-vercel",
    };
  }

  return {
    required: true,
    configured,
    reason: "protected-vercel",
  };
}

export function getWebhookBypassStatusMessage(
  input: WebhookBypassRequirement,
): string {
  if (!input.required && input.reason === "sign-in-with-vercel") {
    return "Webhook bypass is not required in sign-in-with-vercel mode.";
  }

  if (!input.required && input.reason === "local-or-non-vercel") {
    return "Webhook bypass is only required for protected Vercel deployments.";
  }

  if (input.configured) {
    return "Webhook URLs will include x-vercel-protection-bypass.";
  }

  return "Deployment Protection is enabled on Vercel but VERCEL_AUTOMATION_BYPASS_SECRET is missing. Slack, Telegram, and Discord webhooks will be blocked.";
}
