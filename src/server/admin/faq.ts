import { readFile } from "node:fs/promises";
import path from "node:path";

import type { AdminFaqPayload } from "@/shared/admin-faq";
import { getOpenclawPackageSpec } from "@/server/env";

const DEFAULT_REMOTE_FAQ_URL =
  "https://raw.githubusercontent.com/vercel-labs/vercel-openclaw/main/FAQ.md";
const FAQ_FETCH_TIMEOUT_MS = 2_500;

type FetchLike = (
  input: URL | RequestInfo,
  init?: RequestInit,
) => Promise<Response>;

type LoadAdminFaqDeps = {
  fetchFn?: FetchLike;
  readLocalFaq?: () => Promise<string | null>;
};

function normalizeMarkdown(value: string | null): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getOpenclawVersionLabel(): string {
  const spec = getOpenclawPackageSpec().trim();
  if (spec.startsWith("openclaw@")) {
    const version = spec.slice("openclaw@".length).trim();
    return version.length > 0 ? version : spec;
  }
  return spec;
}

function applyFaqTemplate(markdown: string | null): string | null {
  if (!markdown) {
    return null;
  }

  return markdown
    .replaceAll("{{OPENCLAW_PACKAGE_SPEC}}", getOpenclawPackageSpec())
    .replaceAll("{{OPENCLAW_VERSION}}", getOpenclawVersionLabel());
}

async function readLocalFaqFile(): Promise<string | null> {
  try {
    const faqPath = path.join(process.cwd(), "FAQ.md");
    const markdown = await readFile(faqPath, "utf8");
    return applyFaqTemplate(normalizeMarkdown(markdown));
  } catch {
    return null;
  }
}

async function fetchRemoteFaq(fetchFn: FetchLike): Promise<string | null> {
  try {
    const response = await fetchFn(DEFAULT_REMOTE_FAQ_URL, {
      cache: "no-store",
      headers: {
        accept: "text/markdown, text/plain;q=0.9, */*;q=0.1",
      },
      signal: AbortSignal.timeout(FAQ_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return null;
    }

    return applyFaqTemplate(normalizeMarkdown(await response.text()));
  } catch {
    return null;
  }
}

export async function loadAdminFaq(
  deps: LoadAdminFaqDeps = {},
): Promise<AdminFaqPayload> {
  const fetchFn = deps.fetchFn ?? fetch;
  const readLocalFaq = deps.readLocalFaq ?? readLocalFaqFile;

  const remoteMarkdown = await fetchRemoteFaq(fetchFn);
  if (remoteMarkdown) {
    return {
      markdown: remoteMarkdown,
      source: "remote",
      warning: null,
    };
  }

  const localMarkdown = await readLocalFaq();
  if (localMarkdown) {
    return {
      markdown: localMarkdown,
      source: "local",
      warning: "Live FAQ unavailable. Showing the bundled fallback copy.",
    };
  }

  return {
    markdown: null,
    source: "missing",
    warning: "FAQ unavailable.",
  };
}
