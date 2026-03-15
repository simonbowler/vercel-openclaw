/**
 * Load VERCEL_OIDC_TOKEN from the parent project's .env.local
 * so demos can authenticate with the sandbox API.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadEnv() {
  const envPath = resolve(import.meta.dirname, "../../.env.local");
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

export function requireOidc(): string {
  loadEnv();
  const token = process.env.VERCEL_OIDC_TOKEN;
  if (!token) {
    console.error("ERROR: VERCEL_OIDC_TOKEN not found in .env.local");
    console.error("Run: cd .. && vercel env pull");
    process.exit(1);
  }
  return token;
}
