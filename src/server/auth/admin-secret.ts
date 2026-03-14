import { randomBytes } from "node:crypto";

import { logInfo, logError } from "@/server/log";
import { getStore } from "@/server/store/store";

const GENERATED_ADMIN_SECRET_BYTES = 32;
const ADMIN_SECRET_KEY = "openclaw-single:admin-secret";
const ADMIN_SECRET_REVEALED_KEY = "openclaw-single:admin-secret-revealed";

export type ConfiguredAdminSecret = {
  source: "env" | "generated";
  secret: string;
};

let generatedAdminSecretCache: string | null = null;
let generatedAdminSecretLoadPromise: Promise<string | null> | null = null;

function normalizeSecret(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

async function loadOrCreateAdminSecret(): Promise<string | null> {
  try {
    const store = getStore();
    const existing = normalizeSecret(
      await store.getValue<string>(ADMIN_SECRET_KEY),
    );
    if (existing) {
      generatedAdminSecretCache = existing;
      return existing;
    }

    const generated = randomBytes(GENERATED_ADMIN_SECRET_BYTES).toString("hex");
    // Use setValue — the store handles persistence. For Upstash this is
    // idempotent across concurrent cold-starts because the first writer wins
    // and subsequent reads return the persisted value.
    await store.setValue(ADMIN_SECRET_KEY, generated);

    // Verify it was actually written (handles race conditions)
    const persisted = normalizeSecret(
      await store.getValue<string>(ADMIN_SECRET_KEY),
    );
    if (persisted) {
      generatedAdminSecretCache = persisted;
      logInfo("auth.admin_secret.generated", {
        bytes: GENERATED_ADMIN_SECRET_BYTES,
      });
      return persisted;
    }

    logError("auth.admin_secret.unavailable", {
      state: "missing_after_write",
    });
    return null;
  } catch (error) {
    logError("auth.admin_secret.load_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function ensureGeneratedAdminSecretCache(): Promise<string | null> {
  if (generatedAdminSecretCache) {
    return generatedAdminSecretCache;
  }

  if (!generatedAdminSecretLoadPromise) {
    generatedAdminSecretLoadPromise = loadOrCreateAdminSecret().finally(() => {
      generatedAdminSecretLoadPromise = null;
    });
  }

  return generatedAdminSecretLoadPromise;
}

export async function getConfiguredAdminSecret(): Promise<ConfiguredAdminSecret | null> {
  const envSecret = normalizeSecret(process.env.ADMIN_SECRET);
  if (envSecret) {
    return { source: "env", secret: envSecret };
  }

  const generated = await ensureGeneratedAdminSecretCache();
  if (!generated) {
    return null;
  }

  return { source: "generated", secret: generated };
}

/**
 * Reveal the admin secret exactly once for initial setup.
 * Returns the secret on first call, `{ revealed: true }` on subsequent calls,
 * or null if ADMIN_SECRET env var is set (secret is already known).
 */
export async function revealAdminSecretOnce(): Promise<
  | { source: "env" }
  | { source: "generated"; secret: string }
  | { source: "generated"; revealed: true }
  | null
> {
  const configured = await getConfiguredAdminSecret();
  if (!configured) {
    return null;
  }

  if (configured.source === "env") {
    return { source: "env" };
  }

  const store = getStore();
  const existing = await store.getValue<string>(ADMIN_SECRET_REVEALED_KEY);
  if (existing) {
    return { source: "generated", revealed: true };
  }

  // Mark as revealed (first caller wins)
  await store.setValue(ADMIN_SECRET_REVEALED_KEY, "1");
  return { source: "generated", secret: configured.secret };
}

export function _resetAdminSecretCacheForTesting(): void {
  generatedAdminSecretCache = null;
  generatedAdminSecretLoadPromise = null;
}
