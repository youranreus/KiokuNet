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

export interface McpKey {
  id: string;
  agentId: string;
  role: "member" | "leader";
  sourceId?: string;
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
function binding(
  c: Config,
  key: Pick<McpKey, "agentId" | "role" | "sourceId">,
) {
  const agent = c.agents.find((a) => a.id === key.agentId);
  requireThat(
    agent?.active &&
      agent.local &&
      agent.deviceId === c.deviceId &&
      agent.role === key.role &&
      agent.registration !== "conflict",
    "INVALID_BINDING",
    "The key requires an active Hub identity with its original role.",
  );
  requireThat(
    key.role === "leader"
      ? key.sourceId === undefined
      : key.sourceId === agent.id,
    "INVALID_BINDING",
    "Member keys must bind their own Hub source.",
  );
}
export async function createKey(
  home: string,
  c: Config,
  agentId: string,
  role: string,
  replaceId?: string,
) {
  hubOnly(c);
  validId(agentId);
  requireThat(
    role === "member" || role === "leader",
    "USAGE",
    "Role must be member or leader.",
  );
  const key: McpKey = {
    id: randomBytes(8).toString("hex"),
    agentId,
    role,
    ...(role === "member" ? { sourceId: agentId } : {}),
    hash: "",
    createdAt: new Date().toISOString(),
  };
  binding(c, key);
  const token = `kioku_${key.id}_${randomBytes(32).toString("base64url")}`;
  key.hash = sha(token);
  c.mcp ||= { ...settings(c), keys: [] };
  if (replaceId) {
    const old = c.mcp.keys.find((k) => k.id === replaceId && !k.revokedAt);
    requireThat(
      old && old.agentId === agentId && old.role === role,
      "UNKNOWN_KEY",
      "No active matching key.",
    );
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
