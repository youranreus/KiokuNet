import express, { type ErrorRequestHandler, type Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTargetError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { load, sha } from "../core.js";
import { settings } from "./config.js";
import {
  APPROVAL_MS,
  CODE_MS,
  RETRY_MS,
  SCOPE,
  authenticateOAuth,
  AuthorizationRequest,
  ConnectionGrant,
  findToken,
  identifier,
  invalidate,
  oauthReady,
  oauthState,
  OAuthState,
  secret,
  tokenResponse,
  validBinding,
} from "./oauth-store.js";

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (v) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        v
      ]!,
  );
const contentPolicy = (redirectUri?: string) =>
  `default-src 'none'; form-action 'self'${redirectUri ? ` ${new URL(redirectUri).origin}` : ""}; frame-ancestors 'none'; base-uri 'none'`;
function page(res: Response, content: string, redirectUri?: string) {
  // Browsers also check the destination of a form's OAuth redirect. Permit
  // only the registered callback origin, while keeping all other resources off.
  res.set("Content-Security-Policy", contentPolicy(redirectUri));
  // no-referrer makes browsers send Origin: null on HTML form POSTs, which
  // breaks the exact-origin consent check. Keep referrers within this Hub.
  res.set("Referrer-Policy", "same-origin");
  res
    .type("html")
    .send(
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>KiokuNet 授权</title><body><main><h1>连接 KiokuNet</h1>${content}</main></body></html>`,
    );
}
function validateScopes(scopes?: string[]) {
  if (scopes?.some((s) => s !== SCOPE))
    throw new InvalidScopeError("Only kioku:access is supported.");
}
function target(resource: URL | undefined, expected: string) {
  // A single-resource server may infer the audience when omitted. A supplied
  // resource must match exactly at every step; tokens cannot cross Hubs.
  if (resource && resource.href !== expected)
    throw new InvalidTargetError("Resource must match this Hub's MCP URL.");
}
function codeFor(s: OAuthState, clientId: string, code: string, now: number) {
  const value = s.codes.find(
    (c) => c.hash === sha(code) && c.clientId === clientId && c.expiresAt > now,
  );
  if (!value)
    throw new InvalidGrantError("Invalid or expired authorization code.");
  const grant = s.grants.find((g) => g.id === value.grantId);
  if (!grant || grant.revokedAt)
    throw new InvalidGrantError("Connection is no longer active.");
  if (value.consumed) {
    invalidate(grant, "code_reused", now);
    throw new InvalidGrantError("Authorization code has already been used.");
  }
  return { value, grant };
}
function redirectFor(
  request: AuthorizationRequest,
  result: Record<string, string>,
) {
  const redirect = new URL(request.redirectUri);
  for (const [key, value] of Object.entries(result))
    redirect.searchParams.set(key, value);
  if (request.state !== undefined)
    redirect.searchParams.set("state", request.state);
  return redirect.href;
}
const cookieName = (id: string) => `__Host-kioku-${id}`;

export function createOAuthApp(home: string, resource: string) {
  const issuer = new URL(new URL(resource).origin + "/");
  const provider: OAuthServerProvider = {
    clientsStore: {
      getClient: (id) =>
        oauthState(home, (s) => s.clients.find((c) => c.client_id === id)),
      registerClient: (client) =>
        oauthState(home, (s, c, now) => {
          oauthReady(c);
          const method =
            client.token_endpoint_auth_method || "client_secret_post";
          if (
            !["none", "client_secret_post"].includes(method) ||
            !client.redirect_uris.length ||
            client.redirect_uris.length > 10 ||
            client.redirect_uris.some((uri) => {
              const url = new URL(uri);
              return (
                url.protocol !== "https:" ||
                Boolean(url.username || url.password || url.hash) ||
                uri.length > 2048
              );
            }) ||
            client.grant_types?.some(
              (g) => !["authorization_code", "refresh_token"].includes(g),
            ) ||
            client.response_types?.some((r) => r !== "code") ||
            (client.client_name?.length || 0) > 100 ||
            s.clients.length >= 1000
          )
            throw new InvalidClientMetadataError(
              "Use HTTPS callbacks, authorization_code/refresh_token, and none or client_secret_post authentication.",
            );
          validateScopes(client.scope?.split(" "));
          // Only keep fields used by this server; never fetch client-provided URLs.
          const registered: OAuthClientInformationFull = {
            client_id: identifier(),
            client_id_issued_at: Math.floor(now / 1000),
            client_name: client.client_name || "MCP client",
            redirect_uris: client.redirect_uris,
            token_endpoint_auth_method: method,
            ...(method !== "none"
              ? {
                  client_secret: client.client_secret,
                  client_secret_expires_at: 0,
                }
              : {}),
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            scope: SCOPE,
          };
          s.clients.push(registered);
          return registered;
        }),
    },
    async authorize(client, params: AuthorizationParams, res) {
      validateScopes(params.scopes);
      target(params.resource, resource);
      if (
        !/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge) ||
        (params.state?.length || 0) > 2048
      )
        throw new InvalidRequestError(
          "Use S256 PKCE and a bounded state value.",
        );
      // Exact HTTPS callbacks only (no wildcard, fragment or loopback relaxation).
      if (!client.redirect_uris.includes(params.redirectUri))
        throw new InvalidRequestError("Unregistered redirect URI.");
      const nonce = secret();
      const request = await oauthState(home, (s, c, now) => {
        oauthReady(c);
        if (s.requests.length >= 200)
          throw new InvalidRequestError(
            "Too many pending authorization requests.",
          );
        const pending: AuthorizationRequest = {
          id: identifier(),
          clientId: client.client_id,
          redirectUri: params.redirectUri,
          challenge: params.codeChallenge,
          resource,
          state: params.state,
          expiresAt: now + APPROVAL_MS,
          browserHash: sha(nonce),
        };
        s.requests.push(pending);
        return pending;
      });
      res.cookie(cookieName(request.id), nonce, {
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: APPROVAL_MS,
      });
      page(
        res,
        `<p>客户端名称（由客户端提供）：${escape(client.client_name || "MCP client")}</p><p>回调地址：${escape(request.redirectUri)}</p><p>在 Hub 本机生成一次性授权凭证，然后在此输入。请先核对浏览器地址是你自己的 Hub。</p><form method="post" action="/oauth/consent"><input type="hidden" name="request" value="${request.id}"><label>一次性授权凭证 <input type="password" name="credential" required autocomplete="off" maxlength="100"></label><button name="action" value="review">查看授权范围</button><button name="action" value="deny" formnovalidate>取消</button></form>`,
        request.redirectUri,
      );
    },
    challengeForAuthorizationCode: (client, code) =>
      oauthState(home, (s, c, now) => {
        oauthReady(c);
        return codeFor(s, client.client_id, code, now).value.challenge;
      }),
    exchangeAuthorizationCode: (
      client,
      code,
      _verifier,
      redirectUri,
      requestedResource,
    ) =>
      oauthState(home, (s, c, now) => {
        oauthReady(c);
        target(requestedResource, resource);
        const { value, grant } = codeFor(s, client.client_id, code, now);
        if (redirectUri !== value.redirectUri)
          throw new InvalidGrantError(
            "redirect_uri must match the authorization request.",
          );
        value.consumed = true;
        grant.tokensIssuedAt = now;
        return tokenResponse(s, grant, now);
      }),
    exchangeRefreshToken: (client, token, scopes, requestedResource) =>
      oauthState(home, (s, c, now) => {
        oauthReady(c);
        target(requestedResource, resource);
        validateScopes(scopes);
        const found = findToken(s, token, "rt");
        if (
          !found ||
          found.grant.clientId !== client.client_id ||
          found.grant.revokedAt
        )
          throw new InvalidGrantError(
            "Invalid, idle-expired or revoked refresh token.",
          );
        const { grant, counter } = found;
        if (counter === grant.refreshCounter) {
          grant.refreshCounter++;
          grant.tokensIssuedAt = now;
        } else if (
          !(
            counter === grant.refreshCounter - 1 &&
            now - grant.tokensIssuedAt < RETRY_MS
          )
        ) {
          invalidate(grant, "refresh_reused", now);
          throw new InvalidGrantError(
            "Refresh token reuse detected; reconnect and approve again.",
          );
        }
        // A retry returns the same pair, not another generation. Refreshing does
        // not update lastUsedAt, so background traffic cannot keep a grant alive.
        return tokenResponse(s, grant, now);
      }),
    async verifyAccessToken(token) {
      const { key } = await authenticateOAuth(home, token);
      return {
        token,
        clientId: key.clientId,
        scopes: [SCOPE],
        resource: new URL(resource),
      };
    },
    revokeToken: (client, request) =>
      oauthState(home, (s, c, now) => {
        oauthReady(c);
        const found =
          findToken(s, request.token, "rt") ||
          findToken(s, request.token, "at");
        if (found?.grant.clientId === client.client_id)
          invalidate(found.grant, "revoked", now);
      }),
  };
  const app = express();
  app.disable("x-powered-by");
  // A bounded per-Hub budget also covers consent and invalid requests before
  // parsing or disk access. Proxies may impose stricter per-IP limits.
  let windowStart = Date.now(),
    requests = 0;
  app.use((_req, res, next) => {
    if (Date.now() - windowStart >= 60000) {
      windowStart = Date.now();
      requests = 0;
    }
    if (++requests > 240) {
      res
        .set("Retry-After", "60")
        .status(429)
        .json({ error: "temporarily_unavailable" });
      return;
    }
    next();
  });
  // Do not trust forwarded host/proto/IP headers; external URLs come from config.
  app.use(async (_req, res, next) => {
    try {
      const c = await load(home);
      oauthReady(c);
      if (settings(c).publicUrl !== resource)
        throw new Error("OAuth configuration changed.");
      res.set({
        "Cache-Control": "no-store",
        Pragma: "no-cache",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": contentPolicy(),
        "X-Frame-Options": "DENY",
      });
      next();
    } catch {
      res.status(503).json({ error: "temporarily_unavailable" });
    }
  });
  // Also bound requests reaching custom consent or SDK parsers. Repeated scalar
  // parameters must not be interpreted differently by separate middleware.
  app.use(
    express.urlencoded({ extended: false, limit: "16kb", parameterLimit: 30 }),
  );
  app.use(express.json({ limit: "16kb" }));
  app.use((req, res, next) => {
    if (
      [req.query, req.body].some(
        (value) =>
          value &&
          Object.entries(value).some(
            ([key, v]) =>
              ![
                "redirect_uris",
                "grant_types",
                "response_types",
                "contacts",
              ].includes(key) && typeof v !== "string",
          ),
      )
    ) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    next();
  });
  app.post("/oauth/consent", async (req, res) => {
    try {
      if (req.headers.origin !== issuer.origin)
        throw new InvalidRequestError(
          "Submit authorization from this Hub's page.",
        );
      const result = await oauthState(home, (s, c, now) => {
        const request = s.requests.find((r) => r.id === req.body?.request);
        const cookie = req.headers.cookie
          ?.split(";")
          .map((v) => v.trim())
          .find((v) => v.startsWith(`${cookieName(request?.id || "")}=`))
          ?.split("=")[1];
        if (
          !request ||
          request.resource !== settings(c).publicUrl ||
          !cookie ||
          sha(cookie) !== request.browserHash
        )
          throw new InvalidRequestError(
            "Authorization request expired or belongs to another browser. Reconnect.",
          );
        if (req.body.action === "deny") {
          s.requests = s.requests.filter((r) => r !== request);
          return {
            redirect: redirectFor(request, { error: "access_denied" }),
            id: request.id,
          };
        }
        if (req.body.action === "review" && !request.approval) {
          const approval = s.approvals.find(
            (a) => a.hash === sha(String(req.body.credential || "")),
          );
          if (!approval || !validBinding(c, approval))
            throw new InvalidRequestError(
              "Invalid, used or expired approval credential.",
            );
          s.approvals = s.approvals.filter((a) => a !== approval);
          const { hash: _hash, expiresAt, ...identity } = approval;
          request.approval = identity;
          request.expiresAt = Math.min(request.expiresAt, expiresAt);
          return { request };
        }
        if (
          req.body.action !== "approve" ||
          !request.approval ||
          !validBinding(c, request.approval)
        )
          throw new InvalidRequestError(
            "Review a valid Agent binding before approving.",
          );
        const name = String(req.body.name || "").trim();
        if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name))
          throw new InvalidRequestError(
            "Connection name must be 1–80 printable characters.",
          );
        if (s.grants.length >= 1000)
          throw new InvalidRequestError(
            "Connection limit reached; reset OAuth to clear old records.",
          );
        const grant: ConnectionGrant = {
          ...request.approval,
          id: identifier(),
          clientId: request.clientId,
          name,
          createdAt: now,
          lastUsedAt: now,
          refreshCounter: 0,
          tokensIssuedAt: now,
        };
        const code = secret();
        s.grants.push(grant);
        s.codes.push({
          hash: sha(code),
          grantId: grant.id,
          clientId: request.clientId,
          redirectUri: request.redirectUri,
          challenge: request.challenge,
          expiresAt: now + CODE_MS,
        });
        s.requests = s.requests.filter((r) => r !== request);
        return { redirect: redirectFor(request, { code }), id: request.id };
      });
      if (result.redirect) {
        res.set("Content-Security-Policy", contentPolicy(result.redirect));
        res.clearCookie(cookieName(result.id!), {
          secure: true,
          httpOnly: true,
          sameSite: "lax",
          path: "/",
        });
        res.redirect(303, result.redirect);
      } else {
        const request = result.request!,
          identity = request.approval!;
        const permissions =
          identity.role === "leader"
            ? "读取全部活跃来源的 Raw；读写 shared。不能修改 Raw。"
            : `读写自己的 Raw（${identity.sourceId}）；只读 shared。`;
        page(
          res,
          `<h2>确认授权范围</h2><p>Agent：${escape(identity.agentId)}</p><p>角色：${escape(identity.role)}</p><p>${escape(permissions)}</p><p>回调地址：${escape(request.redirectUri)}</p><p>此身份将在不同聊天之间沿用。连续 90 天未成功调用知识工具后需要重新授权；你可以随时在 Hub 撤销连接。</p><form method="post" action="/oauth/consent"><input type="hidden" name="request" value="${request.id}"><label>连接名称 <input name="name" maxlength="80" required value="ChatGPT · ${escape(identity.agentId)}"></label><button name="action" value="approve">批准连接</button><button name="action" value="deny" formnovalidate>取消</button></form>`,
          request.redirectUri,
        );
      }
    } catch (e) {
      res.status(400);
      page(
        res,
        `<p>${escape(e instanceof InvalidRequestError ? e.message : "授权未完成，请重新连接。")}</p>`,
      );
    }
  });
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: issuer,
      resourceServerUrl: new URL(resource),
      scopesSupported: [SCOPE],
      resourceName: "KiokuNet",
      clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
    }),
  );
  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  const errorHandler: ErrorRequestHandler = (_error, _req, res, _next) => {
    if (!res.headersSent) res.status(400).json({ error: "invalid_request" });
  };
  app.use(errorHandler);
  return app;
}
