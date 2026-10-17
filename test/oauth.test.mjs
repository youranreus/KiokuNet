import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { load, save } from "../dist/core.js";
import { configure } from "../dist/mcp/config.js";
import { startMcpServer } from "../dist/mcp/server.js";
import {
  ACCESS_MS,
  IDLE_MS,
  APPROVAL_MS,
  RETRY_MS,
  createApproval,
  listConnections,
  resetOAuth,
  revokeConnection,
} from "../dist/mcp/oauth-store.js";
import { fixture, call, cli } from "./helpers/mcp.mjs";
import { oauthFixture, publicUrl, redirectUri } from "./helpers/oauth.mjs";

test("OAuth is opt-in, requires HTTPS discovery and leaves static Bearer access intact", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await fetch(new URL("/.well-known/oauth-authorization-server", f.url)))
      .status,
    404,
  );
  await assert.rejects(() => configure(f.home, f.c, { oauthEnabled: true }), {
    code: "INVALID_URL",
  });
  await configure(f.home, f.c, { oauthEnabled: true, publicUrl });
  const unauthenticated = await fetch(f.url);
  assert.equal(unauthenticated.status, 401);
  assert.match(
    unauthenticated.headers.get("www-authenticate"),
    /resource_metadata="https:\/\/knowledge.example\/\.well-known\/oauth-protected-resource\/mcp"/,
  );
  const metadata = await (
    await fetch(new URL("/.well-known/oauth-authorization-server", f.url))
  ).json();
  assert.equal(metadata.issuer, "https://knowledge.example/");
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.equal(
    metadata.registration_endpoint,
    "https://knowledge.example/register",
  );
  const resource = await (
    await fetch(new URL("/.well-known/oauth-protected-resource/mcp", f.url))
  ).json();
  assert.equal(resource.resource, publicUrl);
  assert.equal(
    (await call(f.memberClient, "read_file", { path: "/shared/INDEX.md" }))
      .isError,
    false,
  );
});

test("OAuth member and Leader connections preserve knowledge ownership and independent revocation", async (t) => {
  const f = await oauthFixture(t),
    member = await f.grant(),
    leader = await f.grant("leader");
  const memberClient = await f.clientFor(member.tokens.access_token),
    leaderClient = await f.clientFor(leader.tokens.access_token);
  assert.equal(member.tokens.expires_in, 900);
  assert.equal(
    (
      await call(memberClient, "create_file", {
        path: "/raw/writer/oauth.md",
        content: "OAuth knowledge",
      })
    ).isError,
    false,
  );
  assert.equal(
    (
      await call(memberClient, "create_file", {
        path: "/shared/no.md",
        content: "no",
      })
    ).error.code,
    "FORBIDDEN",
  );
  assert.equal(
    (await call(memberClient, "read_file", { path: "/raw/other/secret.md" }))
      .error.code,
    "FORBIDDEN",
  );
  assert.equal(
    (await call(leaderClient, "read_file", { path: "/raw/writer/oauth.md" }))
      .content,
    "OAuth knowledge",
  );
  assert.equal(
    (
      await call(leaderClient, "create_file", {
        path: "/shared/curated.md",
        content: "curated",
      })
    ).isError,
    false,
  );
  assert.equal(
    (
      await call(leaderClient, "create_file", {
        path: "/raw/writer/no.md",
        content: "no",
      })
    ).error.code,
    "FORBIDDEN",
  );
  const connections = await listConnections(f.home);
  assert.equal(connections.length, 2);
  assert.equal(connections[0].agentId, "writer");
  assert.equal(
    JSON.stringify(connections).includes(member.tokens.refresh_token),
    false,
  );
  await revokeConnection(f.home, connections[0].id);
  assert.equal((await f.access(member.tokens.access_token)).status, 401);
  assert.equal((await f.refresh(member)).status, 400);
  assert.equal((await f.access(leader.tokens.access_token)).status, 405);
  assert.equal(
    (await call(f.memberClient, "read_file", { path: "/shared/INDEX.md" }))
      .isError,
    false,
  );
  const state = await readFile(join(f.home, "oauth/state.json"), "utf8");
  const log = await readFile(join(f.dir, "logs/mcp.log"), "utf8");
  for (const value of [
    member.tokens.access_token,
    member.tokens.refresh_token,
    member.flow.approval.credential,
    member.flow.code,
  ]) {
    assert.equal(state.includes(value), false);
    assert.equal(log.includes(value), false);
  }
  assert.equal(
    (await stat(join(f.home, "oauth/state.json"))).mode & 0o777,
    0o600,
  );
});

test("consent binds browser, checks origin, consumes credentials once, displays permissions and supports denial", async (t) => {
  const f = await oauthFixture(t),
    client = await f.register({ client_name: '<script>alert("x")</script>' });
  const flow = await f.begin(client),
    credential = (await createApproval(f.home, "writer")).credential;
  assert.match(flow.html, /&lt;script&gt;/);
  assert.doesNotMatch(flow.html, /<script>/);
  assert.match(flow.response.headers.get("set-cookie"), /Secure/);
  assert.match(
    flow.response.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  assert.equal(
    (
      await f.consent(
        flow,
        { action: "review", credential },
        { Origin: "https://evil.example" },
      )
    ).status,
    400,
  );
  assert.equal(
    (await f.consent(flow, { action: "review", credential }, { Cookie: "" }))
      .status,
    400,
  );
  assert.equal(
    (await f.consent(flow, { action: "approve", name: "bypass" })).status,
    400,
  );
  const review = await f.consent(flow, { action: "review", credential });
  assert.equal(review.status, 200);
  assert.match(
    review.headers.get("content-security-policy"),
    /form-action 'self' https:\/\/chatgpt.com;/,
  );
  const html = await review.text();
  assert.match(html, /writer/);
  assert.match(html, /只读 shared/);
  const other = await f.begin(client);
  assert.equal(
    (await f.consent(other, { action: "review", credential })).status,
    400,
  );
  const denied = await f.consent(flow, { action: "deny" });
  assert.equal(denied.status, 303);
  assert.equal(
    new URL(denied.headers.get("location")).searchParams.get("error"),
    "access_denied",
  );
  assert.equal((await listConnections(f.home)).length, 0);
  await assert.rejects(() => createApproval(f.home, "remote"), {
    code: "INVALID_BINDING",
  });
});

test("authorization enforces PKCE, exact redirect, client, audience, scope, and one-time codes", async (t) => {
  const f = await oauthFixture(t),
    client = await f.register(),
    other = await f.register();
  assert.equal(
    (await f.begin(client, { redirect_uri: "https://evil.example/callback" }))
      .response.status,
    400,
  );
  for (const overrides of [
    { code_challenge_method: "plain" },
    { resource: "https://evil.example/mcp" },
    { scope: "admin" },
  ]) {
    const flow = await f.begin(client, overrides);
    assert.equal(flow.response.status, 302);
    assert.ok(
      new URL(flow.response.headers.get("location")).searchParams.get("error"),
    );
  }
  const flow = await f.approve(client);
  for (const overrides of [
    { code_verifier: "invalid" },
    { redirect_uri: "https://evil.example/callback" },
    { resource: "https://evil.example/mcp" },
  ])
    assert.equal((await f.exchange(client, flow, overrides)).status, 400);
  assert.equal((await f.exchange(other, flow)).status, 400);
  const exchanged = await f.exchange(client, flow);
  assert.equal(exchanged.status, 200);
  const tokens = await exchanged.json();
  assert.equal((await f.exchange(client, flow)).status, 400);
  assert.equal((await f.access(tokens.access_token)).status, 401);
  assert.equal((await listConnections(f.home))[0].reason, "code_reused");
});

test("access expires in 15 minutes; concurrent refresh retries return one pair; late replay revokes the connection", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const f = await oauthFixture(t),
    grant = await f.grant();
  now += ACCESS_MS;
  assert.equal((await f.access(grant.tokens.access_token)).status, 401);
  const replies = await Promise.all([f.refresh(grant), f.refresh(grant)]);
  const [a, b] = await Promise.all(
    replies.map(async (r) => {
      assert.equal(r.status, 200);
      return r.json();
    }),
  );
  assert.deepEqual(a, b);
  assert.notEqual(a.refresh_token, grant.tokens.refresh_token);
  assert.equal((await f.access(a.access_token)).status, 405);
  const other = await f.grant();
  assert.equal(
    (
      await f.token(other.client, {
        grant_type: "refresh_token",
        refresh_token: a.refresh_token,
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.refresh({ ...grant, tokens: a }, { scope: "admin" })).status,
    400,
  );
  assert.equal(
    (
      await f.refresh(
        { ...grant, tokens: a },
        { resource: "https://other.example/mcp" },
      )
    ).status,
    400,
  );
  assert.equal((await f.access(a.access_token)).status, 405);
  now += RETRY_MS;
  assert.equal((await f.refresh(grant)).status, 400);
  assert.equal((await f.access(a.access_token)).status, 401);
  assert.equal((await listConnections(f.home))[0].reason, "refresh_reused");
  assert.equal((await f.access(other.tokens.access_token)).status, 405);
});

test("only successful knowledge tools extend 90-day idle lifetime; active grants have no absolute lifetime", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const f = await oauthFixture(t),
    idle = await f.grant(),
    active = await f.grant();
  const created = (await listConnections(f.home))[0].lastUsedAt;
  now += IDLE_MS - 1;
  idle.tokens = await (await f.refresh(idle)).json();
  const idleClient = await f.clientFor(idle.tokens.access_token);
  await idleClient.listTools();
  assert.equal(
    (await call(idleClient, "read_file", { path: "/raw/other/no.md" })).isError,
    true,
  );
  assert.equal((await listConnections(f.home))[0].lastUsedAt, created);
  active.tokens = await (await f.refresh(active)).json();
  await call(await f.clientFor(active.tokens.access_token), "read_file", {
    path: "/shared/INDEX.md",
  });
  now++;
  assert.equal((await f.refresh(idle)).status, 400);
  assert.equal((await f.access(idle.tokens.access_token)).status, 401);
  assert.equal((await listConnections(f.home))[0].status, "expired");
  // Over a year of legitimate use; each successful call renews only idle time.
  for (let i = 0; i < 5; i++) {
    now += 80 * 24 * 60 * 60 * 1000;
    const refreshed = await f.refresh(active);
    assert.equal(refreshed.status, 200);
    active.tokens = await refreshed.json();
    assert.equal(
      (
        await call(
          await f.clientFor(active.tokens.access_token),
          "list_directory",
          { path: "/" },
        )
      ).isError,
      false,
    );
  }
  assert.equal((await listConnections(f.home))[1].status, "active");
});

test("approval credentials and authorization codes expire independently", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const f = await oauthFixture(t),
    client = await f.register();
  const approval = await createApproval(f.home, "writer");
  now += APPROVAL_MS;
  const flow = await f.begin(client);
  assert.equal(
    (
      await f.consent(flow, {
        action: "review",
        credential: approval.credential,
      })
    ).status,
    400,
  );
  const approved = await f.approve(client);
  now += 60 * 1000;
  assert.equal((await f.exchange(client, approved)).status, 400);
});

test("binding changes revoke old grants permanently, even after disable/enable and role round trips", async (t) => {
  const f = await oauthFixture(t);
  for (const mutate of [
    (a) => {
      a.active = false;
    },
    (a) => {
      a.role = "leader";
    },
    (a) => {
      a.deviceId = "other-device";
    },
  ]) {
    const g = await f.grant(),
      before = await load(f.home),
      after = structuredClone(before);
    mutate(after.agents.find((a) => a.id === "writer"));
    await save(f.home, after);
    // No HTTP request while changed: persisted identity revision still prevents revival.
    await save(f.home, before);
    assert.equal((await f.access(g.tokens.access_token)).status, 401);
    assert.equal((await f.refresh(g)).status, 400);
  }
  const fresh = await f.grant();
  assert.equal((await f.access(fresh.tokens.access_token)).status, 405);
});

test("confidential DCR clients retain credentials, revocation endpoint checks client, and restart preserves grants", async (t) => {
  const f = await oauthFixture(t),
    g = await f.grant("writer", {
      token_endpoint_auth_method: "client_secret_post",
    });
  assert.equal(g.client.client_secret_expires_at, 0);
  assert.equal(
    (
      await f.token(g.client, {
        grant_type: "refresh_token",
        refresh_token: g.tokens.refresh_token,
        client_secret: "wrong",
      })
    ).status,
    400,
  );
  await f.server.close();
  const server = await startMcpServer(f.home, { ...f.c.mcp, port: 0 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address.port}`;
  assert.equal(
    (
      await fetch(base + "/mcp", {
        headers: { Authorization: `Bearer ${g.tokens.access_token}` },
      })
    ).status,
    405,
  );
  const res = await fetch(base + "/revoke", {
    method: "POST",
    body: new URLSearchParams({
      client_id: g.client.client_id,
      client_secret: g.client.client_secret,
      token: g.tokens.refresh_token,
    }),
  });
  assert.equal(res.status, 200);
  assert.equal(
    (
      await fetch(base + "/mcp", {
        headers: { Authorization: `Bearer ${g.tokens.access_token}` },
      })
    ).status,
    401,
  );
});

test("OAuth reset and state loss invalidate old credentials without changing knowledge, Agents or static keys", async (t) => {
  const f = await oauthFixture(t),
    g = await f.grant();
  const before = await load(f.home);
  const backup = await readFile(join(f.home, "oauth/state.json"));
  await revokeConnection(f.home, (await listConnections(f.home))[0].id);
  // Documented restore path: restore files offline, reset OAuth before serving.
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(f.home, "oauth/state.json"), backup);
  await resetOAuth(f.home);
  assert.equal((await f.access(g.tokens.access_token)).status, 401);
  assert.equal((await f.refresh(g)).status, 400);
  assert.deepEqual((await load(f.home)).agents, before.agents);
  assert.equal(
    (await call(f.memberClient, "read_file", { path: "/shared/INDEX.md" }))
      .isError,
    false,
  );
  const fresh = await f.grant();
  await rm(join(f.home, "oauth/state.json"));
  assert.equal((await f.access(fresh.tokens.access_token)).status, 401);
  const replacement = await f.grant();
  assert.equal((await f.access(replacement.tokens.access_token)).status, 405);
});

test("CLI manages OAuth approvals and connections without leaking stored credentials", async (t) => {
  const f = await oauthFixture(t);
  assert.equal(
    cli(f.dir, ["mcp", "oauth", "approve", "--agent", "writer"]).ok,
    true,
  );
  const g = await f.grant();
  const listed = cli(f.dir, ["mcp", "oauth", "list"]);
  assert.equal(listed.ok, true);
  assert.equal(listed.data.connections[0].name, "ChatGPT writer");
  const revoked = cli(f.dir, [
    "mcp",
    "oauth",
    "revoke",
    "--connection",
    listed.data.connections[0].id,
  ]);
  assert.equal(revoked.ok, true);
  assert.equal((await f.access(g.tokens.access_token)).status, 401);
  assert.equal(
    cli(f.dir, ["mcp", "oauth", "reset"]).error.code,
    "CONFIRM_REQUIRED",
  );
  assert.equal(
    cli(f.dir, ["mcp", "oauth", "reset", "--confirm", "oauth"]).ok,
    true,
  );
  assert.equal(cli(f.dir, ["mcp", "oauth", "disable"]).ok, true);
  assert.equal((await f.request("/register")).status, 404);
});

test("official SDK performs discovery, DCR, PKCE exchange and refresh against real HTTP endpoints", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const f = await oauthFixture(t);
  let info, tokens, verifier, authorizationUrl;
  const provider = {
    redirectUrl: redirectUri,
    clientMetadata: {
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    },
    clientInformation: () => info,
    saveClientInformation: (value) => {
      info = value;
    },
    tokens: () => tokens,
    saveTokens: (value) => {
      tokens = value;
    },
    saveCodeVerifier: (value) => {
      verifier = value;
    },
    codeVerifier: () => verifier,
    redirectToAuthorization: (url) => {
      authorizationUrl = url;
    },
  };
  const fetchFn = (url, init) => {
    const u = new URL(url);
    assert.equal(u.origin, new URL(publicUrl).origin);
    return fetch(f.base + u.pathname + u.search, init);
  };
  assert.equal(
    await auth(provider, { serverUrl: publicUrl, fetchFn }),
    "REDIRECT",
  );
  const response = await fetchFn(authorizationUrl);
  const html = await response.text();
  const flow = {
    id: /name="request" value="([a-f0-9]+)"/.exec(html)[1],
    cookie: response.headers.get("set-cookie").split(";")[0],
  };
  const approval = await createApproval(f.home, "writer");
  assert.equal(
    (
      await f.consent(flow, {
        action: "review",
        credential: approval.credential,
      })
    ).status,
    200,
  );
  const consent = await f.consent(flow, {
    action: "approve",
    name: "SDK acceptance",
  });
  const code = new URL(consent.headers.get("location")).searchParams.get(
    "code",
  );
  assert.equal(
    await auth(provider, {
      serverUrl: publicUrl,
      authorizationCode: code,
      fetchFn,
    }),
    "AUTHORIZED",
  );
  const original = tokens.refresh_token;
  assert.equal(
    (
      await call(await f.clientFor(tokens.access_token), "read_file", {
        path: "/shared/INDEX.md",
      })
    ).isError,
    false,
  );
  const client = new Client({ name: "oauth-acceptance", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(publicUrl), {
      authProvider: provider,
      fetch: fetchFn,
    }),
  );
  now += ACCESS_MS;
  assert.equal(
    (await call(client, "read_file", { path: "/shared/INDEX.md" })).isError,
    false,
  );
  assert.notEqual(tokens.refresh_token, original);
});

test("DCR rejects unsafe callbacks and unsupported auth; malformed requests and forged tokens do not alter grants", async (t) => {
  const f = await oauthFixture(t);
  for (const patch of [
    { redirect_uris: ["http://evil.example/callback"] },
    { redirect_uris: ["https://user:secret@example.com/callback"] },
    { redirect_uris: ["https://example.com/callback#fragment"] },
    { token_endpoint_auth_method: "client_secret_basic" },
    { grant_types: ["client_credentials"] },
  ]) {
    const res = await f.request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        ...patch,
      }),
    });
    assert.equal(res.status, 400);
  }
  const g = await f.grant();
  assert.equal(
    (await f.refresh(g, { refresh_token: g.tokens.refresh_token + "x" }))
      .status,
    400,
  );
  assert.equal((await f.access(g.tokens.access_token + "x")).status, 401);
  assert.equal((await listConnections(f.home))[0].status, "active");
  const duplicate = await f.request("/token", {
    method: "POST",
    body: new URLSearchParams([
      ["client_id", g.client.client_id],
      ["client_id", "other"],
      ["grant_type", "refresh_token"],
      ["refresh_token", g.tokens.refresh_token],
    ]),
  });
  assert.equal(duplicate.status, 400);
  assert.equal(
    (
      await f.request("/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "x".repeat(17000) }),
      })
    ).status,
    400,
  );
  assert.equal((await f.access(g.tokens.access_token)).status, 405);
});

test("changing the public URL and back never revives grants; corrupted storage fails closed and can be reset", async (t) => {
  const f = await oauthFixture(t),
    g = await f.grant();
  const c = await load(f.home);
  await configure(f.home, c, { publicUrl: "https://new.example/mcp" });
  await configure(f.home, c, { publicUrl });
  assert.equal((await f.access(g.tokens.access_token)).status, 401);
  const fresh = await f.grant();
  const { writeFile } = await import("node:fs/promises");
  const file = join(f.home, "oauth/state.json");
  await writeFile(file, "broken-json");
  assert.equal((await f.access(fresh.tokens.access_token)).status, 401);
  assert.equal(await readFile(file, "utf8"), "broken-json");
  assert.equal(
    (await call(f.memberClient, "read_file", { path: "/shared/INDEX.md" }))
      .isError,
    false,
  );
  await resetOAuth(f.home);
  assert.equal(
    (await f.access((await f.grant()).tokens.access_token)).status,
    405,
  );
});
