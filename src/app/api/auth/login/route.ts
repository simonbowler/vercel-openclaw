import { loginWithAdminSecret } from "@/server/auth/admin-auth";
import { isSecureRequest } from "@/server/auth/session";
import { logInfo, logWarn } from "@/server/log";
import { jsonError } from "@/shared/http";

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as { secret?: unknown };
    if (typeof body.secret !== "string" || body.secret.trim().length === 0) {
      return Response.json(
        { error: "INVALID_SECRET", message: "Secret must be a non-empty string." },
        { status: 400 },
      );
    }

    const result = await loginWithAdminSecret(
      body.secret.trim(),
      isSecureRequest(request),
    );

    if (!result) {
      logWarn("auth.login_failed");
      return Response.json(
        { error: "UNAUTHORIZED", message: "Invalid admin secret." },
        { status: 401 },
      );
    }

    logInfo("auth.login_success");
    const response = Response.json({ ok: true });
    response.headers.append("Set-Cookie", result.setCookieHeader);
    return response;
  } catch (error) {
    return jsonError(error);
  }
}
