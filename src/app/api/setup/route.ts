import { revealAdminSecretOnce } from "@/server/auth/admin-secret";
import { jsonError } from "@/shared/http";

export async function GET(): Promise<Response> {
  try {
    const result = await revealAdminSecretOnce();
    if (!result) {
      return Response.json(
        { error: "ADMIN_SECRET_UNAVAILABLE", message: "Admin secret is not configured." },
        { status: 503 },
      );
    }

    return Response.json(result);
  } catch (error) {
    return jsonError(error);
  }
}
