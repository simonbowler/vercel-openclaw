import { createChannelAdminRouteHandlers } from "@/server/channels/admin/route-factory";
import { setWhatsAppChannelConfig } from "@/server/channels/state";
import { logInfo } from "@/server/log";
import { ApiError } from "@/shared/http";

type PutWhatsAppBody = {
  enabled?: boolean;
  phoneNumberId?: string;
  accessToken?: string;
  verifyToken?: string;
  appSecret?: string;
  businessAccountId?: string;
  pluginSpec?: string;
  accountId?: string;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: string[];
  groupPolicy?: "open" | "allowlist" | "disabled";
  groupAllowFrom?: string[];
  groups?: string[];
};

type DmPolicy = NonNullable<PutWhatsAppBody["dmPolicy"]>;
type GroupPolicy = NonNullable<PutWhatsAppBody["groupPolicy"]>;

const VALID_DM_POLICIES: ReadonlySet<DmPolicy> = new Set<DmPolicy>(["pairing", "allowlist", "open", "disabled"]);
const VALID_GROUP_POLICIES: ReadonlySet<GroupPolicy> = new Set<GroupPolicy>(["open", "allowlist", "disabled"]);

function requireJsonObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_JSON", "Request body must be a JSON object.");
  }

  return value as Record<string, unknown>;
}

function requireOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new ApiError(400, `INVALID_${field.toUpperCase()}`, `${field} must be a boolean`);
  }
  return value;
}

function requireOptionalTrimmedString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(400, `INVALID_${field.toUpperCase()}`, `${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireOptionalEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: ReadonlySet<T>,
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.has(value.trim() as T)) {
    throw new ApiError(
      400,
      `INVALID_${field.toUpperCase()}`,
      `${field} must be one of: ${Array.from(allowed).join(", ")}`,
    );
  }
  return value.trim() as T;
}

function requireOptionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ApiError(400, `INVALID_${field.toUpperCase()}`, `${field} must be an array of non-empty strings`);
  }
  return value.map((item) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new ApiError(400, `INVALID_${field.toUpperCase()}`, `${field} must be an array of non-empty strings`);
    }
    return item.trim();
  });
}

export const { GET, PUT, DELETE } = createChannelAdminRouteHandlers({
  channel: "whatsapp",

  selectState(fullState) {
    return fullState.whatsapp;
  },

  async put({ request, meta }) {
    const body = requireJsonObject(await request.json()) as PutWhatsAppBody;

    const existing = meta.channels.whatsapp;
    const enabled = requireOptionalBoolean(body.enabled, "enabled") ?? existing?.enabled ?? true;
    const phoneNumberId =
      requireOptionalTrimmedString(body.phoneNumberId, "phoneNumberId") ?? existing?.phoneNumberId;
    const accessToken =
      requireOptionalTrimmedString(body.accessToken, "accessToken") ?? existing?.accessToken;
    const verifyToken =
      requireOptionalTrimmedString(body.verifyToken, "verifyToken") ?? existing?.verifyToken;
    const appSecret =
      requireOptionalTrimmedString(body.appSecret, "appSecret") ?? existing?.appSecret;
    const businessAccountId =
      requireOptionalTrimmedString(body.businessAccountId, "businessAccountId") ??
      existing?.businessAccountId;
    const pluginSpec = requireOptionalTrimmedString(body.pluginSpec, "pluginSpec") ?? existing?.pluginSpec;
    const accountId = requireOptionalTrimmedString(body.accountId, "accountId") ?? existing?.accountId;
    const dmPolicy =
      requireOptionalEnum(body.dmPolicy, "dmPolicy", VALID_DM_POLICIES) ?? existing?.dmPolicy;
    const allowFrom = requireOptionalStringArray(body.allowFrom, "allowFrom") ?? existing?.allowFrom;
    const groupPolicy =
      requireOptionalEnum(body.groupPolicy, "groupPolicy", VALID_GROUP_POLICIES) ?? existing?.groupPolicy;
    const groupAllowFrom =
      requireOptionalStringArray(body.groupAllowFrom, "groupAllowFrom") ?? existing?.groupAllowFrom;
    const groups = requireOptionalStringArray(body.groups, "groups") ?? existing?.groups;

    if (!phoneNumberId) {
      throw new ApiError(400, "INVALID_PHONENUMBERID", "phoneNumberId must be a non-empty string");
    }
    if (!accessToken) {
      throw new ApiError(400, "INVALID_ACCESSTOKEN", "accessToken must be a non-empty string");
    }
    if (!verifyToken) {
      throw new ApiError(400, "INVALID_VERIFYTOKEN", "verifyToken must be a non-empty string");
    }
    if (!appSecret) {
      throw new ApiError(400, "INVALID_APPSECRET", "appSecret must be a non-empty string");
    }

    await setWhatsAppChannelConfig({
      enabled,
      configuredAt: existing?.configuredAt ?? Date.now(),
      phoneNumberId,
      accessToken,
      verifyToken,
      appSecret,
      businessAccountId,
      pluginSpec,
      accountId,
      dmPolicy,
      allowFrom,
      groupPolicy,
      groupAllowFrom,
      groups,
      lastKnownLinkState: existing?.lastKnownLinkState,
      linkedPhone: existing?.linkedPhone,
      displayName: existing?.displayName,
      lastError: existing?.lastError,
    });

    logInfo("channels.whatsapp_config_updated", {
      enabled,
      hasPhoneNumberId: Boolean(phoneNumberId),
      hasAccessToken: Boolean(accessToken),
      hasVerifyToken: Boolean(verifyToken),
      hasAppSecret: Boolean(appSecret),
      hasBusinessAccountId: Boolean(businessAccountId),
      hasPluginSpec: Boolean(pluginSpec),
      hasAccountId: Boolean(accountId),
      dmPolicy: dmPolicy ?? "pairing",
      allowFromCount: allowFrom?.length ?? 0,
      groupPolicy: groupPolicy ?? "allowlist",
      groupAllowFromCount: groupAllowFrom?.length ?? 0,
      groupsCount: groups?.length ?? 0,
    });
  },

  async delete() {
    await setWhatsAppChannelConfig(null);
    logInfo("channels.whatsapp_config_removed", {});
  },
});
