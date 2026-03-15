import assert from "node:assert/strict";
import test from "node:test";

import { buildJsonRouteErrorMessage } from "@/components/api-route-errors";

test("prefers nested error message and appends connectability issues", () => {
  const message = buildJsonRouteErrorMessage(
    {
      error: {
        code: "CHANNEL_CONNECT_BLOCKED",
        message:
          "Cannot connect slack until deployment blockers are resolved.",
      },
      connectability: {
        channel: "slack",
        issues: [
          {
            message:
              "Slack requires a public HTTPS webhook URL before it can be connected.",
            env: ["NEXT_PUBLIC_APP_URL"],
          },
          {
            message:
              "Slack cannot reach a protected Vercel deployment until VERCEL_AUTOMATION_BYPASS_SECRET is configured.",
            env: ["VERCEL_AUTOMATION_BYPASS_SECRET"],
          },
        ],
      },
    },
    "Save Slack failed",
  );

  assert.equal(
    message,
    "Cannot connect slack until deployment blockers are resolved. Slack requires a public HTTPS webhook URL before it can be connected. (NEXT_PUBLIC_APP_URL) Slack cannot reach a protected Vercel deployment until VERCEL_AUTOMATION_BYPASS_SECRET is configured. (VERCEL_AUTOMATION_BYPASS_SECRET)",
  );
});

test("falls back to generic message when payload is empty", () => {
  assert.equal(
    buildJsonRouteErrorMessage(null, "Save Slack failed"),
    "Save Slack failed",
  );
});

test("uses top-level message when error object is absent", () => {
  assert.equal(
    buildJsonRouteErrorMessage(
      { message: "Something went wrong" },
      "fallback",
    ),
    "Something went wrong",
  );
});

test("shows issues without env arrays cleanly", () => {
  const message = buildJsonRouteErrorMessage(
    {
      error: { message: "Blocked." },
      connectability: {
        issues: [{ message: "No public origin." }],
      },
    },
    "fallback",
  );
  assert.equal(message, "Blocked. No public origin.");
});
