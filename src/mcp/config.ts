import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import {
  Config,
  Failure,
  load,
  readJson,
  requireThat,
  save,
  sha,
  validId,
} from "../core.js";

export interface AccessPermissions {
  readSpaces: "*" | string[];
  writeSpaces: string[];
  shared: "none" | "read" | "read-write";
}
export interface AccessGrant {
  id: string;
  permissions: AccessPermissions;
  bindingRevision: string;
}
export interface McpKey extends AccessGrant {
  hash: string;
  createdAt: string;
  revokedAt?: string;
}
export interface McpSettings {
  enabled: boolean;
  host: string;
  port: number;
  publicUrl?: string;
  allowedOrigins: string[];
  maxFileBytes: number;
  maxKeywords: number;
  maxResults: number;
  searchTimeoutMs: number;
  oauthEnabled: boolean;
}
export interface McpConfig extends McpSettings {
  keys: McpKey[];
}
export const defaults: McpSettings = {
  enabled: false,
  host: "0.0.0.0",
  port: 7331,
  allowedOrigins: [],
  maxFileBytes: 1024 * 1024,
  maxKeywords: 32,
  maxResults: 200,
  searchTimeoutMs: 10000,
  oauthEnabled: false,
};
export function settings(c: Config): McpSettings {
  const { keys: _, ...value } = c.mcp || { ...defaults, keys: [] };
  return { ...defaults, ...value };
}
export const revision = (c: Config) => sha(JSON.stringify(settings(c)));
export function hubOnly(c: Config) {
  requireThat(
    c.mode === "hub",
    "HUB_REQUIRED",
    "MCP is only available on the Hub.",
  );
}
export function normalizePermissions(
  c: Config,
  input: AccessPermissions,
): AccessPermissions {
  requireThat(
    input &&
      (input.readSpaces === "*" || Array.isArray(input.readSpaces)) &&
      Array.isArray(input.writeSpaces) &&
      ["none", "read", "read-write"].includes(input.shared),
    "INVALID_PERMISSIONS",
    "Specify space read/write scopes and a Shared access level.",
  );
  const permissions: AccessPermissions = {
    readSpaces:
      input.readSpaces === "*"
        ? "*"
        : [...new Set(input.readSpaces.map(validId))].sort(),
    writeSpaces: [...new Set(input.writeSpaces.map(validId))].sort(),
    shared: input.shared,
  };
  for (const id of new Set([
    ...(permissions.readSpaces === "*" ? [] : permissions.readSpaces),
    ...permissions.writeSpaces,
  ])) {
    const space = c.spaces.find(
      (s) => s.id === id && s.active && s.registration !== "conflict",
    );
    requireThat(space, "UNKNOWN_SPACE", `No active space: ${id}.`);
    requireThat(
      !permissions.writeSpaces.includes(id) ||
        (space.local && space.deviceId === c.deviceId),
      "WRITER_CONFLICT",
      `Only the owning node may write space ${id}; Hub MCP cannot forward writes.`,
    );
  }
  return permissions;
}
export function accessRevision(c: Config, permissions: AccessPermissions) {
  const ids = [
    ...new Set([
      ...(permissions.readSpaces === "*" ? [] : permissions.readSpaces),
      ...permissions.writeSpaces,
    ]),
  ].sort();
  return sha(
    JSON.stringify([
      c.networkId,
      c.deviceId,
      c.root,
      c.mode,
      permissions,
      ids.map((id) => {
        const space = c.spaces.find((s) => s.id === id);
        return [
          id,
          space?.authorizationRevision,
          space?.active,
          space?.local,
          space?.deviceId,
          space?.registration === "conflict",
        ];
      }),
    ]),
  );
}
export function grantAccess(
  c: Config,
  permissions: AccessPermissions,
): AccessGrant {
  hubOnly(c);
  permissions = normalizePermissions(c, permissions);
  return {
    id: randomBytes(16).toString("hex"),
    permissions,
    bindingRevision: accessRevision(c, permissions),
  };
}
export function binding(c: Config, grant: AccessGrant) {
  hubOnly(c);
  normalizePermissions(c, grant.permissions);
  requireThat(
    grant.bindingRevision === accessRevision(c, grant.permissions),
    "INVALID_BINDING",
    "Access scope or space ownership changed; authorize a new connection.",
  );
}
export async function createKey(
  home: string,
  c: Config,
  permissions: AccessPermissions,
  replaceId?: string,
) {
  const access = grantAccess(c, permissions);
  const key: McpKey = {
    ...access,
    id: randomBytes(8).toString("hex"),
    hash: "",
    createdAt: new Date().toISOString(),
  };
  const token = `kioku_${key.id}_${randomBytes(32).toString("base64url")}`;
  key.hash = sha(token);
  c.mcp ||= { ...settings(c), keys: [] };
  if (replaceId) {
    const old = c.mcp.keys.find((k) => k.id === replaceId && !k.revokedAt);
    requireThat(
      old &&
        JSON.stringify(old.permissions) === JSON.stringify(key.permissions),
      "UNKNOWN_KEY",
      "No active key with matching scopes.",
    );
    binding(c, old);
    old.revokedAt = new Date().toISOString();
  }
  c.mcp.keys.push(key);
  await save(home, c);
  const { hash: _, ...metadata } = key;
  return {
    ...metadata,
    token,
    instruction: "Store this token now. It cannot be displayed again.",
  };
}
export function listKeys(c: Config) {
  hubOnly(c);
  return (c.mcp?.keys || []).map(({ hash: _, ...key }) => key);
}
export async function revokeKey(home: string, c: Config, id: string) {
  hubOnly(c);
  const key = c.mcp?.keys.find((k) => k.id === id);
  requireThat(key, "UNKNOWN_KEY", "Unknown MCP key.");
  key.revokedAt ||= new Date().toISOString();
  await save(home, c);
  return { id, revokedAt: key.revokedAt };
}
export async function authenticate(home: string, authorization?: string) {
  const c = await load(home);
  if (c.mode !== "hub" || !settings(c).enabled)
    throw new Failure("UNAUTHORIZED", "Invalid or revoked bearer token.");
  if (/^Bearer kioku_at_/i.test(authorization || "")) {
    const { authenticateOAuth } = await import("./oauth-store.js");
    return authenticateOAuth(home, authorization!.slice(7));
  }
  const match = /^Bearer (kioku_([a-f0-9]{16})_[A-Za-z0-9_-]{43})$/i.exec(
    authorization || "",
  );
  const key = c.mcp?.keys.find((k) => k.id === match?.[2] && !k.revokedAt);
  const digest = Buffer.from(sha(match?.[1] || ""), "hex");
  const expected = Buffer.from(key?.hash || "", "hex");
  if (
    !key ||
    expected.length !== digest.length ||
    !timingSafeEqual(digest, expected)
  )
    throw new Failure("UNAUTHORIZED", "Invalid or revoked bearer token.");
  try {
    binding(c, key);
  } catch {
    throw new Failure("UNAUTHORIZED", "Invalid or revoked bearer token.");
  }
  return { c, key };
}
export async function configure(
  home: string,
  c: Config,
  patch: Partial<McpSettings>,
) {
  hubOnly(c);
  const urlValue = (value: string, code: string) => {
    try {
      return new URL(value);
    } catch {
      throw new Failure(code, "Specify a valid absolute HTTP(S) URL.");
    }
  };
  const next = { ...settings(c), ...patch };
  requireThat(
    typeof next.host === "string" &&
      next.host.length > 0 &&
      !/[\s/\\]/.test(next.host),
    "INVALID_HOST",
    "Specify a listening IP or hostname.",
  );
  requireThat(
    Number.isInteger(next.port) && next.port > 0 && next.port < 65536,
    "INVALID_PORT",
    "Port must be 1–65535.",
  );
  for (const name of [
    "maxFileBytes",
    "maxKeywords",
    "maxResults",
    "searchTimeoutMs",
  ] as const)
    requireThat(
      Number.isSafeInteger(next[name]) &&
        next[name] > 0 &&
        next[name] <=
          (name === "maxFileBytes"
            ? 64 * 1024 * 1024
            : name === "searchTimeoutMs"
              ? 300000
              : 10000),
      "INVALID_LIMIT",
      `Invalid ${name} limit.`,
    );
  if (next.publicUrl) {
    const url = urlValue(next.publicUrl, "INVALID_URL");
    requireThat(
      url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === "/mcp",
      "INVALID_URL",
      "Public URL must be https://HOST[:PORT]/mcp without credentials or query parameters.",
    );
    next.publicUrl = url.toString();
  }
  requireThat(
    !next.oauthEnabled || next.publicUrl,
    "INVALID_URL",
    "OAuth requires an HTTPS public URL; configure --public-url first.",
  );
  for (const origin of next.allowedOrigins) {
    const url = urlValue(origin, "INVALID_ORIGIN");
    requireThat(
      ["http:", "https:"].includes(url.protocol) && origin === url.origin,
      "INVALID_ORIGIN",
      "Origins must be exact HTTP(S) origins, without a trailing slash.",
    );
  }
  c.mcp = { ...next, keys: c.mcp?.keys || [] };
  await save(home, c);
}
export interface McpRuntimeStatus {
  pid: number;
  revision: string;
  running: boolean;
  updatedAt: string;
  error?: string;
}
export async function mcpStatus(home: string, c: Config) {
  let runtime: McpRuntimeStatus | undefined;
  try {
    runtime = await readJson<McpRuntimeStatus>(join(home, "mcp.json"));
    process.kill(runtime.pid, 0);
  } catch {
    runtime = undefined;
  }
  const current =
    runtime?.revision === revision(c) &&
    Date.now() - Date.parse(runtime.updatedAt) < 15000;
  return {
    ...settings(c),
    running: Boolean(settings(c).enabled && current && runtime?.running),
    applied: Boolean(current),
    error: current ? runtime?.error : undefined,
    updatedAt: runtime?.updatedAt,
    keyCount: (c.mcp?.keys || []).filter((k) => !k.revokedAt).length,
  };
}
