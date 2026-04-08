import { isVercelDeployment } from "@/server/env";
import { logInfo, logWarn } from "@/server/log";
import { getProtectionBypassSecret, resolvePublicOrigin } from "@/server/public-url";

/**
 * Tri-state result from probing whether Vercel Deployment Protection is active.
 *
 * - `"clear"` — probe got the expected 200 + JSON response; protection is not active
 *   (or bypass secret is working correctly when configured)
 * - `"detected"` — probe got a Vercel SSO redirect or auth challenge; protection is
 *   active and webhooks will be blocked
 * - `"indeterminate"` — probe failed for an unrelated reason (timeout, network error,
 *   unexpected response); cannot determine protection state
 * - `"skipped"` — preconditions not met (not on Vercel, no public origin)
 */
export type DeploymentProtectionStatus =
  | "clear"
  | "detected"
  | "indeterminate"
  | "skipped";

export type DeploymentProtectionProbeResult = {
  status: DeploymentProtectionStatus;
  probeError: string | null;
};

// ---------------------------------------------------------------------------
// TTL-cached probe with in-flight deduplication
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000;

let cachedResult: DeploymentProtectionProbeResult | null = null;
let cachedAt = 0;
let inflightPromise: Promise<DeploymentProtectionProbeResult> | null = null;

function isCacheValid(): boolean {
  return cachedResult !== null && Date.now() - cachedAt < CACHE_TTL_MS;
}

/**
 * Probe whether Vercel Deployment Protection is active on this deployment.
 *
 * When a bypass secret is configured, the probe includes it to verify the
 * secret still works (catches stale secrets after rotation).
 *
 * Results are cached for 60 seconds with in-flight deduplication so
 * concurrent callers share a single probe.
 */
export async function probeDeploymentProtection(
  request?: Request,
): Promise<DeploymentProtectionProbeResult> {
  if (testOverride) return testOverride;
  if (isCacheValid()) return cachedResult!;
  if (inflightPromise) return inflightPromise;

  inflightPromise = runProbe(request).then((result) => {
    cachedResult = result;
    cachedAt = Date.now();
    inflightPromise = null;
    return result;
  }).catch((error) => {
    inflightPromise = null;
    const result: DeploymentProtectionProbeResult = {
      status: "indeterminate",
      probeError: error instanceof Error ? error.message : String(error),
    };
    cachedResult = result;
    cachedAt = Date.now();
    return result;
  });

  return inflightPromise;
}

async function runProbe(
  request?: Request,
): Promise<DeploymentProtectionProbeResult> {
  if (!isVercelDeployment()) {
    return { status: "skipped", probeError: null };
  }

  let publicOrigin: string;
  try {
    publicOrigin = resolvePublicOrigin(request).origin;
  } catch {
    return { status: "skipped", probeError: null };
  }

  // Build probe URL — include bypass secret when configured to verify it works
  const probeUrl = new URL("/api/health", publicOrigin);
  const bypassSecret = getProtectionBypassSecret();
  if (bypassSecret) {
    probeUrl.searchParams.set("x-vercel-protection-bypass", bypassSecret);
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    const response = await fetch(probeUrl.toString(), {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const result = interpretProbeResponse(response);

    logInfo("deployment_protection.probed", {
      status: result.status,
      httpStatus: response.status,
      bypassIncluded: Boolean(bypassSecret),
      publicOrigin,
    });

    return result;
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "Probe timed out after 5s"
        : error instanceof Error
          ? error.message
          : String(error);

    logWarn("deployment_protection.probe_error", {
      error: message,
      publicOrigin,
    });

    return { status: "indeterminate", probeError: message };
  }
}

// Vercel SSO redirect hosts that signal deployment protection
const VERCEL_AUTH_HOSTS = ["vercel.com", "www.vercel.com"];

function interpretProbeResponse(
  response: Response,
): DeploymentProtectionProbeResult {
  const status = response.status;

  // 3xx redirect — check if it's a Vercel SSO redirect
  if (status >= 300 && status < 400) {
    const location = response.headers.get("location");
    if (location) {
      try {
        const host = new URL(location).hostname.toLowerCase();
        if (VERCEL_AUTH_HOSTS.includes(host)) {
          return { status: "detected", probeError: null };
        }
      } catch {
        // Non-URL location header; not a Vercel redirect
      }
    }
    return { status: "indeterminate", probeError: `Unexpected redirect: ${status}` };
  }

  // 401/403 — check for Vercel auth markers
  if (status === 401 || status === 403) {
    // Vercel deployment protection returns 401 with SSO HTML.
    // We don't read the body to keep the probe lightweight — a 401/403
    // from a Vercel deployment without our app's auth (health endpoint
    // is unauthenticated) strongly signals deployment protection.
    return { status: "detected", probeError: null };
  }

  // 200 — expected healthy response
  if (status === 200) {
    return { status: "clear", probeError: null };
  }

  // Anything else is ambiguous
  return {
    status: "indeterminate",
    probeError: `Unexpected status: ${status}`,
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let testOverride: DeploymentProtectionProbeResult | null = null;

/**
 * Inject a fixed probe result for testing. Prevents real network calls
 * from preflight and connectability tests. Pass `null` to clear.
 */
export function _setProbeResultForTesting(
  result: DeploymentProtectionProbeResult | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("_setProbeResultForTesting is only available in test mode");
  }
  testOverride = result;
}

export function _resetProbeForTesting(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("_resetProbeForTesting is only available in test mode");
  }
  cachedResult = null;
  cachedAt = 0;
  inflightPromise = null;
  testOverride = null;
}
