import { jsonError, jsonOk } from "@/shared/http";
import { requireAdminAuth, requireAdminMutationAuth } from "@/server/auth/admin-auth";

type AdminAuthResult = Exclude<
  Awaited<ReturnType<typeof requireAdminAuth>>,
  Response
>;

/**
 * Require admin auth for JSON API routes.
 * For mutations (POST/PUT/DELETE), also enforces CSRF for cookie sessions.
 */
export async function requireJsonRouteAuth(
  request: Request,
): Promise<Response | AdminAuthResult> {
  const method = request.method.toUpperCase();
  const isMutation = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";

  if (isMutation) {
    return requireAdminMutationAuth(request);
  }

  return requireAdminAuth(request);
}

/**
 * Require admin auth + CSRF for mutation routes.
 */
export async function requireMutationAuth(
  request: Request,
): Promise<Response | AdminAuthResult> {
  return requireAdminMutationAuth(request);
}

export function authJsonOk<T>(
  data: T,
  auth: { setCookieHeader: string | null } | null,
  init?: ResponseInit,
): Response {
  const response = jsonOk(data, init);
  if (auth?.setCookieHeader) {
    response.headers.append("Set-Cookie", auth.setCookieHeader);
  }
  return response;
}

export function authJsonError(
  error: unknown,
  auth: { setCookieHeader: string | null } | null = null,
  init?: ResponseInit,
): Response {
  const response = jsonError(error, init);
  if (auth?.setCookieHeader) {
    response.headers.append("Set-Cookie", auth.setCookieHeader);
  }
  return response;
}
