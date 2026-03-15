export type JsonRouteErrorPayload = {
  message?: string;
  error?: {
    code?: string;
    message?: string;
  };
  connectability?: {
    channel?: string;
    issues?: Array<{
      id?: string;
      status?: string;
      message: string;
      env?: string[];
    }>;
  };
};

export function buildJsonRouteErrorMessage(
  payload: JsonRouteErrorPayload | null,
  fallback: string,
): string {
  const base = payload?.error?.message ?? payload?.message ?? fallback;
  const issues = payload?.connectability?.issues ?? [];

  if (issues.length === 0) {
    return base;
  }

  return [
    base,
    ...issues.map((issue) =>
      Array.isArray(issue.env) && issue.env.length > 0
        ? `${issue.message} (${issue.env.join(", ")})`
        : issue.message,
    ),
  ].join(" ");
}
