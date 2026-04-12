import { authJsonOk, requireJsonRouteAuth } from "@/server/auth/route-auth";
import { loadAdminFaq } from "@/server/admin/faq";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const faq = await loadAdminFaq();
  return authJsonOk(faq, auth);
}
