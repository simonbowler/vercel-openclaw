import { requireJsonRouteAuth } from "@/server/auth/route-auth";
import { getFirewallDiagnostics } from "@/server/firewall/state";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const diagnostics = await getFirewallDiagnostics();
  const response = Response.json(diagnostics);
  if (auth.setCookieHeader) {
    response.headers.append("Set-Cookie", auth.setCookieHeader);
  }
  return response;
}
