import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { fixture, permissionsFor } from "./mcp.mjs";
import { createApproval } from "../../dist/mcp/oauth-store.js";

export const publicUrl = "https://knowledge.example/mcp";
export const redirectUri =
  "https://chatgpt.com/connector_platform/oauth_redirect";
export async function oauthFixture(t) {
  const f = await fixture(t, { oauthEnabled: true, publicUrl });
  return oauthEndpoints(f);
}
export function oauthEndpoints(f) {
  const base = new URL(f.url).origin;
  const request = async (path, init) => {
    // CLI helpers use spawnSync during restart, preventing undici from seeing
    // socket-close events. Do not reuse a socket across that process boundary.
    try {
      return await fetch(base + path, {
        redirect: "manual",
        ...init,
        headers: { Connection: "close", ...init?.headers },
      });
    } catch (cause) {
      throw new Error(`OAuth request failed: ${path}`, { cause });
    }
  };
  const form = (path, data, headers = {}) =>
    request(path, {
      method: "POST",
      headers,
      body: new URLSearchParams(data),
    });
  const register = async (overrides = {}) => {
    const response = await request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "ChatGPT",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        ...overrides,
      }),
    });
    assert.equal(response.status, 201, await response.clone().text());
    return response.json();
  };
  const begin = async (client, overrides = {}) => {
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource: publicUrl,
      scope: "kioku:access",
      state: "browser-state",
      ...overrides,
    });
    const response = await request(`/authorize?${query}`);
    const html = await response.text();
    const id = /name="request" value="([a-f0-9]+)"/.exec(html)?.[1];
    return {
      response,
      html,
      id,
      verifier,
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  };
  const consent = (flow, data, headers = {}) =>
    form(
      "/oauth/consent",
      {
        request: flow.id,
        ...data,
      },
      { Cookie: flow.cookie, Origin: new URL(publicUrl).origin, ...headers },
    );
  const approve = async (client, agent = "writer") => {
    const flow = await begin(client);
    assert.equal(flow.response.status, 200, flow.html);
    const approval = await createApproval(f.home, permissionsFor(agent));
    const review = await consent(flow, {
      action: "review",
      credential: approval.credential,
    });
    assert.equal(review.status, 200, await review.clone().text());
    const accepted = await consent(flow, {
      action: "approve",
      name: `ChatGPT ${agent}`,
    });
    assert.equal(accepted.status, 303, await accepted.clone().text());
    const callback = new URL(accepted.headers.get("location"));
    assert.equal(callback.searchParams.get("state"), "browser-state");
    return { ...flow, code: callback.searchParams.get("code"), approval };
  };
  const token = (client, data) =>
    form("/token", {
      client_id: client.client_id,
      ...(client.client_secret ? { client_secret: client.client_secret } : {}),
      resource: publicUrl,
      ...data,
    });
  const exchange = (client, flow, overrides = {}) =>
    token(client, {
      grant_type: "authorization_code",
      code: flow.code,
      code_verifier: flow.verifier,
      redirect_uri: redirectUri,
      ...overrides,
    });
  const grant = async (agent = "writer", overrides = {}) => {
    const client = await register(overrides),
      flow = await approve(client, agent);
    const response = await exchange(client, flow);
    assert.equal(response.status, 200, await response.clone().text());
    return { client, flow, tokens: await response.json() };
  };
  const refresh = (g, overrides = {}) =>
    token(g.client, {
      grant_type: "refresh_token",
      refresh_token: g.tokens.refresh_token,
      ...overrides,
    });
  const access = (token) =>
    request("/mcp", { headers: { Authorization: `Bearer ${token}` } });
  return {
    ...f,
    base,
    request,
    form,
    register,
    begin,
    consent,
    approve,
    token,
    exchange,
    grant,
    refresh,
    access,
  };
}
