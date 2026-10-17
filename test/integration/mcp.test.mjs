import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { cli, connect, call } from "../helpers/mcp.mjs";
import { removeFixture } from "../helpers/files.mjs";
import { oauthEndpoints } from "../helpers/oauth.mjs";

async function reserve() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
async function port() {
  const r = await reserve();
  await r.close();
  return r.port;
}
function ok(home, args) {
  const result = cli(home, args);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}

test(
  "Hub worker enables/disables MCP live, persists keys across restart and isolates bind failures from sync",
  { timeout: 90000 },
  async (t) => {
    const home = await realpath(
      await mkdtemp(join(tmpdir(), "kioku-mcp-worker-")),
    );
    const clients = [];
    let occupied;
    t.after(async () => {
      await Promise.all(clients.map((c) => c.close()));
      if (occupied) await occupied.close();
      cli(home, ["service", "stop"]);
      await removeFixture(home);
    });
    ok(home, [
      "init",
      "--address",
      `127.0.0.1:${await port()}`,
      "--service",
      "manual",
    ]);
    assert.equal(ok(home, ["mcp", "status"]).enabled, false);
    assert.equal(ok(home, ["mcp", "status"]).running, false);
    ok(home, ["source", "add", "--agent", "writer"]);
    ok(home, ["source", "add", "--agent", "leader", "--role", "leader"]);
    const key = ok(home, ["mcp", "key", "create", "--agent", "writer"]);
    const listenPort = await port(),
      url = `http://127.0.0.1:${listenPort}/mcp`;
    const enabled = ok(home, [
      "mcp",
      "enable",
      "--host",
      "127.0.0.1",
      "--port",
      String(listenPort),
      "--public-url",
      "https://knowledge.example/mcp",
    ]);
    assert.equal(enabled.running, true);
    let client = await connect(url, key.token);
    clients.push(client);
    assert.equal(
      (
        await call(client, "create_file", {
          path: "/raw/writer/live.md",
          content: "created remotely",
        })
      ).isError,
      false,
    );
    const initial = ok(home, ["status"]);
    assert.equal(initial.sync.running, true);
    assert.equal(initial.mcp.running, true);
    const pid = initial.worker.pid;
    const disabled = ok(home, ["mcp", "disable"]);
    assert.equal(disabled.running, false);
    assert.equal(disabled.enabled, false);
    assert.equal(ok(home, ["status"]).worker.pid, pid);
    await assert.rejects(() => fetch(url));
    assert.equal(ok(home, ["mcp", "enable"]).running, true);
    assert.equal(ok(home, ["status"]).worker.pid, pid);
    ok(home, ["mcp", "oauth", "enable"]);
    const oauth = oauthEndpoints({ home: join(home, "config"), url });
    const oauthGrant = await oauth.grant();
    ok(home, ["service", "restart"]);
    const restarted = ok(home, ["mcp", "status"]);
    assert.equal(restarted.running, true);
    assert.equal(restarted.keyCount, 1);
    assert.equal(restarted.oauthEnabled, true);
    assert.equal(
      (await oauth.access(oauthGrant.tokens.access_token)).status,
      405,
    );
    const refreshed = await oauth.refresh(oauthGrant);
    assert.equal(refreshed.status, 200);
    const oauthClient = await connect(
      url,
      (await refreshed.json()).access_token,
    );
    clients.push(oauthClient);
    assert.equal(
      (await call(oauthClient, "read_file", { path: "/raw/writer/live.md" }))
        .content,
      "created remotely",
    );
    client = await connect(url, key.token);
    clients.push(client);
    assert.equal(
      (await call(client, "read_file", { path: "/raw/writer/live.md" }))
        .content,
      "created remotely",
    );
    occupied = await reserve();
    const conflict = cli(home, [
      "mcp",
      "enable",
      "--port",
      String(occupied.port),
    ]);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error.code, "MCP_NOT_READY");
    const failed = ok(home, ["status"]);
    assert.equal(failed.sync.running, true);
    assert.equal(failed.mcp.running, false);
    assert.equal(failed.mcp.enabled, true);
    assert.equal(failed.mcp.error, "EADDRINUSE");
    assert.equal(
      ok(home, ["mcp", "enable", "--port", String(listenPort)]).running,
      true,
    );
    ok(home, ["mcp", "key", "revoke", "--key", key.id]);
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${key.token}` },
        })
      ).status,
      401,
    );
    ok(home, ["mcp", "disable"]);
    assert.equal(ok(home, ["status"]).sync.running, true);
  },
);

test(
  "paired remote Raw remains read-only through Hub MCP while local Raw and shared synchronize",
  { timeout: 90000 },
  async (t) => {
    const root = await realpath(
        await mkdtemp(join(tmpdir(), "kioku-mcp-sync-")),
      ),
      hub = join(root, "hub"),
      node = join(root, "node");
    const clients = [];
    t.after(async () => {
      await Promise.all(clients.map((c) => c.close()));
      for (const home of [node, hub]) cli(home, ["service", "stop"]);
      await removeFixture(root);
    });
    ok(hub, [
      "init",
      "--address",
      `127.0.0.1:${await port()}`,
      "--service",
      "manual",
    ]);
    ok(hub, ["invite", "--out", join(root, "invite")]);
    ok(node, [
      "join",
      "--invite",
      join(root, "invite"),
      "--out",
      join(root, "receipt"),
      "--service",
      "manual",
      "--listen-port",
      String(await port()),
    ]);
    ok(hub, ["enroll", "--receipt", join(root, "receipt")]);
    ok(hub, ["source", "add", "--agent", "leader", "--role", "leader"]);
    ok(node, ["source", "add", "--agent", "remote"]);
    await writeFile(
      join(node, "data/agents/remote/raw/evidence.md"),
      "remote source text",
    );
    const leader = ok(hub, ["mcp", "key", "create", "--agent", "leader"]);
    const listenPort = await port();
    ok(hub, [
      "mcp",
      "enable",
      "--host",
      "127.0.0.1",
      "--port",
      String(listenPort),
    ]);
    ok(node, ["service", "start"]);
    const client = await connect(
      `http://127.0.0.1:${listenPort}/mcp`,
      leader.token,
    );
    clients.push(client);
    let result;
    for (let i = 0; i < 150; i++) {
      result = await call(client, "read_file", {
        path: "/raw/remote/evidence.md",
      });
      if (!result.isError) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(result.content, "remote source text", JSON.stringify(result));
    assert.equal(
      (
        await call(client, "write_file", {
          path: "/raw/remote/evidence.md",
          content: "forbidden",
          version: result.version,
        })
      ).error.code,
      "FORBIDDEN",
    );
    assert.equal(
      (
        await call(client, "create_file", {
          path: "/shared/mcp.md",
          content: "published through MCP",
        })
      ).isError,
      false,
    );
    const { readFile } = await import("node:fs/promises");
    let shared;
    for (let i = 0; i < 150; i++) {
      shared = await readFile(join(node, "data/shared/mcp.md"), "utf8").catch(
        () => undefined,
      );
      if (shared === "published through MCP") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(shared, "published through MCP");
    assert.equal(cli(node, ["mcp", "enable"]).error.code, "HUB_REQUIRED");
  },
);
