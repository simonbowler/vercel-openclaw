import { authJsonError, authJsonOk, requireJsonRouteAuth } from "@/server/auth/route-auth";
import { buildSlackManifest } from "@/server/channels/slack/app-definition";
import { buildPublicDisplayUrl } from "@/server/public-url";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    // Use the display URL (no bypass query parameter) for the Slack manifest.
    // Slack authenticates via HMAC signature, not via the bypass secret.
    // Including the bypass parameter can interfere with Slack's URL verification.
    const webhookUrl = buildPublicDisplayUrl("/api/channels/slack/webhook", request);
    const manifest = buildSlackManifest(webhookUrl);
    const manifestJson = JSON.stringify(manifest);
    const createAppUrl =
      `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(manifestJson)}`;

    return authJsonOk(
      {
        manifest,
        createAppUrl,
      },
      auth,
    );
  } catch (error) {
    return authJsonError(error, auth);
  }
}
