import { jsonError } from "@/shared/http";
import { requireMutationAuth, requireJsonRouteAuth } from "@/server/auth/route-auth";
import { logInfo } from "@/server/log";
import { getInitializedMeta } from "@/server/store/store";
import { getPublicOrigin } from "@/server/public-url";
import {
  prepareRestoreTarget,
  type PrepareRestoreResult,
} from "@/server/sandbox/lifecycle";

/**
 * GET  — returns current restore-target state (read-only).
 * POST — prepares a verified restore target.
 *
 * Request body (POST):
 * ```json
 * { "destructive": true }
 * ```
 */

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const meta = await getInitializedMeta();

    const payload: PrepareRestoreResult = {
      ok: meta.restorePreparedStatus === "ready",
      destructive: false,
      state: meta.restorePreparedStatus,
      reason: meta.restorePreparedReason,
      snapshotId: meta.snapshotId,
      snapshotDynamicConfigHash: meta.snapshotDynamicConfigHash,
      runtimeDynamicConfigHash: meta.runtimeDynamicConfigHash,
      snapshotAssetSha256: meta.snapshotAssetSha256,
      runtimeAssetSha256: meta.runtimeAssetSha256,
      preparedAt: meta.restorePreparedAt,
      actions: [],
    };

    logInfo("prepare_restore.get", {
      state: payload.state,
      reason: payload.reason,
    });

    const response = Response.json(payload);
    if (auth.setCookieHeader) {
      response.headers.append("Set-Cookie", auth.setCookieHeader);
    }
    return response;
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    let destructive = false;
    try {
      const body = await request.json();
      destructive = body?.destructive === true;
    } catch {
      // empty body is fine — defaults to non-destructive
    }

    const origin = getPublicOrigin(request);

    const result = await prepareRestoreTarget({
      origin,
      reason: "operator-request",
      destructive,
    });

    logInfo("prepare_restore.post", {
      ok: result.ok,
      destructive: result.destructive,
      state: result.state,
      actionCount: result.actions.length,
    });

    const response = Response.json(result);
    if (auth.setCookieHeader) {
      response.headers.append("Set-Cookie", auth.setCookieHeader);
    }
    return response;
  } catch (error) {
    return jsonError(error);
  }
}
