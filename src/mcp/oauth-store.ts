import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  atomicJson,
  Config,
  Failure,
  load,
  readJson,
  requireThat,
  sha,
  withLock,
} from "../core.js";
import {
  binding,
  hubOnly,
  AccessGrant,
  AccessPermissions,
  grantAccess,
  settings,
} from "./config.js";

export const ACCESS_MS = 15 * 60 * 1000;
export const IDLE_MS = 90 * 24 * 60 * 60 * 1000;
export const APPROVAL_MS = 10 * 60 * 1000;
export const CODE_MS = 60 * 1000;
export const RETRY_MS = 30 * 1000;
export const SCOPE = "kioku:access";
export const secret = () => randomBytes(32).toString("base64url");
export const identifier = () => randomBytes(16).toString("hex");

export interface BoundGrant extends AccessGrant {
  resource: string;
  resourceRevision?: string;
}
export interface ConnectionGrant extends BoundGrant {
  name: string;
  clientId: string;
  createdAt: number;
  lastUsedAt: number;
  refreshCounter: number;
  tokensIssuedAt: number;
  revokedAt?: number;
  reason?: string;
}
export interface AuthorizationRequest {
  id: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string;
  state?: string;
  expiresAt: number;
  browserHash: string;
  approval?: BoundGrant;
}
interface Approval extends BoundGrant {
  hash: string;
  expiresAt: number;
}
export interface AuthorizationCode {
  hash: string;
  grantId: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  expiresAt: number;
  consumed?: boolean;
}
export interface OAuthState {
  version: 1;
  tokenKey: string;
  clients: OAuthClientInformationFull[];
  approvals: Approval[];
  requests: AuthorizationRequest[];
  codes: AuthorizationCode[];
  grants: ConnectionGrant[];
}
const emptyState = (): OAuthState => ({
  version: 1,
  tokenKey: secret(),
  clients: [],
  approvals: [],
  requests: [],
  codes: [],
  grants: [],
});
export function oauthReady(c: Config) {
  hubOnly(c);
  requireThat(
    settings(c).enabled && settings(c).oauthEnabled && settings(c).publicUrl,
    "OAUTH_DISABLED",
    "Enable MCP and OAuth with an HTTPS public URL first.",
  );
}
export function boundGrant(
  c: Config,
  permissions: AccessPermissions,
): BoundGrant {
  return {
    ...grantAccess(c, permissions),
    resource: settings(c).publicUrl!,
    resourceRevision: c.oauthRevision,
  };
}
export function validBinding(c: Config, value: BoundGrant) {
  try {
    binding(c, value);
    return (
      value.resource === settings(c).publicUrl &&
      value.resourceRevision === c.oauthRevision
    );
  } catch {
    return false;
  }
}
export function invalidate(
  grant: ConnectionGrant,
  reason: string,
  now: number,
) {
  grant.revokedAt ??= now;
  grant.reason ??= reason;
}

// Separate cross-process lock from config mutations. Save security changes even
// when an operation rejects (e.g. refresh-token replay); never reset corrupt data.
export async function oauthState<T>(
  home: string,
  work: (state: OAuthState, c: Config, now: number) => T | Promise<T>,
): Promise<T> {
  return withLock(join(home, "oauth"), async () => {
    const file = join(home, "oauth", "state.json");
    let state: OAuthState;
    try {
      state = await readJson<OAuthState>(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      state = emptyState();
    }
    requireThat(
      state.version === 1 &&
        typeof state.tokenKey === "string" &&
        state.tokenKey.length === 43 &&
        [
          state.clients,
          state.approvals,
          state.requests,
          state.codes,
          state.grants,
        ].every(Array.isArray),
      "INVALID_OAUTH_STATE",
      "Invalid OAuth state; use mcp oauth reset for recovery.",
    );
    const before = JSON.stringify(state),
      c = await load(home),
      now = Date.now();
    hubOnly(c);
    state.approvals = state.approvals.filter((a) => a.expiresAt > now);
    state.requests = state.requests.filter((r) => r.expiresAt > now);
    state.codes = state.codes.filter((v) => v.expiresAt > now);
    for (const grant of state.grants) {
      if (!validBinding(c, grant)) invalidate(grant, "binding_changed", now);
      if (now - grant.lastUsedAt >= IDLE_MS)
        invalidate(grant, "idle_expired", now);
    }
    // Abandoned registrations are bounded, but credentials for established
    // connections never expire merely because an access token was refreshed.
    state.clients = state.clients.filter(
      (client) =>
        now - (client.client_id_issued_at || 0) * 1000 < 24 * 60 * 60 * 1000 ||
        state.grants.some((g) => g.clientId === client.client_id) ||
        state.requests.some((r) => r.clientId === client.client_id),
    );
    try {
      return await work(state, c, now);
    } finally {
      if (JSON.stringify(state) !== before) await atomicJson(file, state);
    }
  });
}

export async function createApproval(
  home: string,
  permissions: AccessPermissions,
) {
  return oauthState(home, (s, c, now) => {
    oauthReady(c);
    requireThat(
      s.approvals.length < 100,
      "OAUTH_LIMIT",
      "Too many pending approval credentials.",
    );
    const approval = boundGrant(c, permissions),
      token = `kioku_approve_${secret()}`;
    s.approvals.push({
      ...approval,
      hash: sha(token),
      expiresAt: now + APPROVAL_MS,
    });
    return {
      permissions: approval.permissions,
      credential: token,
      expiresAt: new Date(now + APPROVAL_MS).toISOString(),
      publicUrl: approval.resource,
      instruction:
        "Enter this credential only on your Hub authorization page. Single use; expires in 10 minutes.",
    };
  });
}
export async function listConnections(home: string) {
  return oauthState(home, (s, c) =>
    s.grants.map((g) => ({
      id: g.id,
      name: g.name,
      clientId: g.clientId,
      permissions: g.permissions,
      createdAt: new Date(g.createdAt).toISOString(),
      lastUsedAt: new Date(g.lastUsedAt).toISOString(),
      idleExpiresAt: new Date(g.lastUsedAt + IDLE_MS).toISOString(),
      status:
        g.reason === "idle_expired"
          ? "expired"
          : g.revokedAt
            ? "revoked"
            : !settings(c).enabled || !settings(c).oauthEnabled
              ? "disabled"
              : "active",
      reason: g.reason,
      revokedAt: g.revokedAt ? new Date(g.revokedAt).toISOString() : undefined,
    })),
  );
}
export async function revokeConnection(home: string, id: string) {
  return oauthState(home, (s, _c, now) => {
    const grant = s.grants.find((g) => g.id === id);
    requireThat(grant, "UNKNOWN_CONNECTION", "Unknown OAuth connection.");
    invalidate(grant, "revoked", now);
    return { id, revokedAt: new Date(grant.revokedAt!).toISOString() };
  });
}
export async function resetOAuth(home: string, config?: Config) {
  // Works even if state.json is damaged; callers run this before exposing a
  // restored Hub. Keeping no old signing key prevents old grants reviving.
  return withLock(join(home, "oauth"), async () => {
    hubOnly(config || (await load(home)));
    await atomicJson(join(home, "oauth", "state.json"), emptyState());
    return {
      reset: true,
      instruction:
        "Reconnect clients and approve again. Spaces, knowledge and static keys are unchanged.",
    };
  });
}
function mac(s: OAuthState, value: string) {
  return createHmac("sha256", s.tokenKey).update(value).digest("base64url");
}
function signedToken(s: OAuthState, value: string) {
  return `${value}_${mac(s, value)}`;
}
function verifiedToken(s: OAuthState, token: string) {
  // base64url MACs contain underscores; the signature is always 43 chars.
  const value = token.slice(0, -44),
    signature = token.slice(-43);
  if (token.at(-44) !== "_") return false;
  const actual = Buffer.from(signature),
    expected = Buffer.from(mac(s, value));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function tokenResponse(
  s: OAuthState,
  grant: ConnectionGrant,
  now: number,
) {
  const expires = grant.tokensIssuedAt + ACCESS_MS;
  return {
    access_token: signedToken(
      s,
      `kioku_at_${grant.id}_${grant.refreshCounter}_${expires}`,
    ),
    refresh_token: signedToken(
      s,
      `kioku_rt_${grant.id}_${grant.refreshCounter}`,
    ),
    token_type: "Bearer",
    expires_in: Math.max(0, Math.floor((expires - now) / 1000)),
    scope: SCOPE,
  };
}
export function findToken(s: OAuthState, token: string, type: "at" | "rt") {
  if (token.length > 256 || !verifiedToken(s, token)) return;
  const re =
    type === "at"
      ? /^kioku_at_([a-f0-9]{32})_(\d+)_(\d+)_[A-Za-z0-9_-]{43}$/
      : /^kioku_rt_([a-f0-9]{32})_(\d+)_[A-Za-z0-9_-]{43}$/;
  const match = re.exec(token);
  if (!match) return;
  const grant = s.grants.find((g) => g.id === match[1]);
  if (!grant) return;
  return { grant, counter: Number(match[2]), expires: Number(match[3]) };
}
export async function authenticateOAuth(home: string, token: string) {
  return oauthState(home, (s, c, now) => {
    const result = findToken(s, token, "at");
    if (
      !settings(c).enabled ||
      !settings(c).oauthEnabled ||
      !result ||
      result.grant.revokedAt ||
      result.expires <= now ||
      result.counter > result.grant.refreshCounter
    )
      throw new Failure(
        "UNAUTHORIZED",
        "Invalid, expired or revoked OAuth token.",
      );
    return { c, key: result.grant };
  });
}
export async function recordOAuthActivity(home: string, authorization: string) {
  if (!/^Bearer kioku_at_/i.test(authorization)) return;
  return oauthState(home, (s, c, now) => {
    const result = findToken(s, authorization.slice(7), "at");
    requireThat(
      settings(c).enabled &&
        settings(c).oauthEnabled &&
        result &&
        !result.grant.revokedAt &&
        result.expires > now,
      "UNAUTHORIZED",
      "OAuth connection is no longer active.",
    );
    result.grant.lastUsedAt = now;
  });
}
