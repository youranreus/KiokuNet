import { test } from "node:test";
import assert from "node:assert/strict";
import {
  writeFile,
  readFile,
  mkdir,
  symlink,
  link,
  lstat,
} from "node:fs/promises";
import { join } from "node:path";
import { save } from "../dist/core.js";
import { fixture, call, cli, connect } from "./helpers/mcp.mjs";

test("MCP SDK client discovers tools and completes create/read/edit/write with versions", async (t) => {
  const f = await fixture(t),
    client = f.memberClient;
  assert.deepEqual(
    (await client.listTools()).tools.map((t) => t.name).sort(),
    [
      "create_directory",
      "create_file",
      "edit_file",
      "list_directory",
      "read_file",
      "search_content",
      "search_files",
      "write_file",
    ].sort(),
  );
  assert.equal(
    (await call(client, "create_directory", { path: "/raw/writer/notes/deep" }))
      .isError,
    false,
  );
  const path = "/raw/writer/notes/deep/note.md";
  assert.equal(
    (await call(client, "create_file", { path, content: "记忆\n同步" }))
      .isError,
    false,
  );
  assert.equal(
    (await call(client, "create_file", { path, content: "oops" })).error.code,
    "ALREADY_EXISTS",
  );
  assert.equal(
    (
      await call(client, "create_file", {
        path: "/raw/writer/missing/note",
        content: "x",
      })
    ).error.code,
    "NOT_FOUND",
  );
  let read = await call(client, "read_file", { path });
  assert.equal(read.content, "记忆\n同步");
  const edit = await call(client, "edit_file", {
    path,
    oldText: "同步",
    newText: "同步成功",
    version: read.version,
  });
  assert.equal(edit.isError, false);
  assert.equal(
    (
      await call(client, "write_file", {
        path,
        content: "stale",
        version: read.version,
      })
    ).error.code,
    "VERSION_CONFLICT",
  );
  read = await call(client, "read_file", { path });
  assert.equal(read.content, "记忆\n同步成功");
  assert.equal(
    (
      await call(client, "write_file", {
        path,
        content: "final",
        version: read.version,
      })
    ).isError,
    false,
  );
  assert.equal(
    await readFile(
      join(f.c.root, "agents/writer/raw/notes/deep/note.md"),
      "utf8",
    ),
    "final",
  );
});

test("member and Leader roots enforce role and single-writer ownership", async (t) => {
  const f = await fixture(t),
    member = f.memberClient,
    leader = f.leaderClient;
  await writeFile(
    join(f.c.root, "agents/remote/raw/remote.md"),
    "remote evidence",
  );
  assert.deepEqual(
    (await call(member, "list_directory", { path: "/raw" })).entries.map(
      (e) => e.name,
    ),
    ["writer"],
  );
  assert.equal(
    (await call(member, "read_file", { path: "/shared/INDEX.md" })).isError,
    false,
  );
  for (const path of [
    "/shared/new.md",
    "/raw/other/new.md",
    "/raw/remote/new.md",
    "/raw/leader/new.md",
  ])
    assert.equal(
      (await call(member, "create_file", { path, content: "x" })).error.code,
      "FORBIDDEN",
    );
  assert.equal(
    (await call(member, "list_directory", { path: "/raw/remote" })).error.code,
    "FORBIDDEN",
  );
  assert.equal(
    (await call(leader, "read_file", { path: "/raw/remote/remote.md" }))
      .content,
    "remote evidence",
  );
  assert.equal(
    (
      await call(leader, "create_file", {
        path: "/shared/new.md",
        content: "published",
      })
    ).isError,
    false,
  );
  for (const id of ["writer", "leader", "remote"])
    assert.equal(
      (
        await call(leader, "create_file", {
          path: `/raw/${id}/new.md`,
          content: "x",
        })
      ).error.code,
      "FORBIDDEN",
    );
  assert.equal(
    (
      await call(member, "search_content", {
        path: "/raw/remote",
        keywords: ["remote"],
      })
    ).error.code,
    "FORBIDDEN",
  );
});

test("virtual paths reject traversal, links, control files and physical-path disclosure", async (t) => {
  const f = await fixture(t),
    raw = join(f.c.root, "agents/writer/raw");
  await writeFile(join(f.dir, "private.txt"), "private");
  await symlink(f.dir, join(raw, "escape"));
  await symlink(join(f.dir, "private.txt"), join(raw, "linked"));
  await link(join(f.dir, "private.txt"), join(raw, "hardlinked"));
  await writeFile(join(raw, ".stignore"), "private controls");
  for (const path of [
    "/raw/writer/../other/a",
    "/raw/writer//a",
    "/raw/writer/a\\b",
    "/raw/writer/.stignore",
    "/raw/writer/.STIGNORE",
    "/raw/writer/escape/private.txt",
    "/raw/writer/linked",
    "/raw/writer/hardlinked",
    f.dir + "/private.txt",
  ]) {
    const result = await call(f.memberClient, "read_file", { path });
    assert.equal(result.isError, true, path);
    assert.ok(!JSON.stringify(result).includes(f.dir));
  }
  assert.equal(
    (
      await call(f.memberClient, "create_file", {
        path: "/raw/writer/escape/injected",
        content: "x",
      })
    ).error.code,
    "UNSAFE_PATH",
  );
  assert.deepEqual(
    (await call(f.memberClient, "list_directory", { path: "/raw/writer" }))
      .entries,
    [],
  );
});

test("MCP serializes competing edits and rejects ambiguous replacements", async (t) => {
  const f = await fixture(t),
    path = "/raw/writer/note";
  await call(f.memberClient, "create_file", { path, content: "same same" });
  const { version } = await call(f.memberClient, "read_file", { path });
  assert.equal(
    (
      await call(f.memberClient, "edit_file", {
        path,
        oldText: "same",
        newText: "x",
        version,
      })
    ).error.code,
    "EDIT_NOT_UNIQUE",
  );
  const results = await Promise.all(
    ["one", "two"].map((content) =>
      call(f.memberClient, "write_file", { path, content, version }),
    ),
  );
  assert.equal(results.filter((r) => !r.isError).length, 1);
  assert.equal(results.find((r) => r.isError).error.code, "VERSION_CONFLICT");
  const current = await call(f.memberClient, "read_file", { path });
  await writeFile(join(f.c.root, "agents/writer/raw/note"), "external change");
  assert.equal(
    (
      await call(f.memberClient, "write_file", {
        path,
        content: "old",
        version: current.version,
      })
    ).error.code,
    "VERSION_CONFLICT",
  );
});

test("multi-keyword content and filename searches support any/all, case, subpaths and binary names", async (t) => {
  const f = await fixture(t),
    raw = join(f.c.root, "agents/writer/raw");
  await mkdir(join(raw, "notes"));
  await writeFile(
    join(raw, "notes/Alpha.md"),
    "记忆 Alpha\n同步 BETA\nAlpha BETA\n",
  );
  await writeFile(join(raw, "only.md"), "Alpha only");
  await writeFile(join(raw, "photo.bin"), Buffer.from([0xff, 0, 1]));
  await writeFile(join(f.c.root, "agents/other/raw/secret.md"), "Alpha BETA");
  let result = await call(f.memberClient, "search_content", {
    keywords: ["alpha", "beta"],
    mode: "all",
  });
  assert.equal(result.results.length, 3);
  assert.ok(
    result.results.every((r) => r.path === "/raw/writer/notes/Alpha.md"),
  );
  assert.deepEqual(result.results.find((r) => r.line === 3).keywords, [
    "alpha",
    "beta",
  ]);
  assert.equal(
    result.skipped.find((r) => r.path.endsWith("photo.bin")).reason,
    "NOT_UTF8_TEXT",
  );
  assert.equal(result.complete, false);
  result = await call(f.memberClient, "search_content", {
    keywords: ["alpha", "beta"],
    mode: "any",
    caseSensitive: true,
    path: "/raw/writer/notes",
  });
  assert.equal(result.results.length, 0);
  assert.equal(result.complete, true);
  result = await call(f.memberClient, "search_files", { keywords: ["photo"] });
  assert.deepEqual(
    result.results.map((r) => r.path),
    ["/raw/writer/photo.bin"],
  );
  result = await call(f.memberClient, "search_files", {
    keywords: ["notes", "alpha"],
    mode: "all",
    matchPath: true,
  });
  assert.deepEqual(
    result.results.map((r) => r.path),
    ["/raw/writer/notes/Alpha.md"],
  );
  assert.equal(
    (
      await call(f.memberClient, "search_files", {
        keywords: ["notes"],
        matchPath: false,
      })
    ).results.length,
    0,
  );
});

test("limits reject oversized/nontext writes and report incomplete search and directory cursors", async (t) => {
  const f = await fixture(t);
  f.c.mcp.maxFileBytes = 64;
  f.c.mcp.maxResults = 1;
  f.c.mcp.maxKeywords = 2;
  await save(f.home, f.c);
  const raw = join(f.c.root, "agents/writer/raw");
  for (const name of ["a", "b", "c"])
    await writeFile(join(raw, name), "needle");
  await writeFile(join(raw, "big"), "x".repeat(65));
  assert.equal(
    (await call(f.memberClient, "read_file", { path: "/raw/writer/big" })).error
      .code,
    "FILE_TOO_LARGE",
  );
  assert.equal(
    (
      await call(f.memberClient, "create_file", {
        path: "/raw/writer/no",
        content: "x".repeat(65),
      })
    ).error.code,
    "FILE_TOO_LARGE",
  );
  assert.equal(
    (
      await call(f.memberClient, "create_file", {
        path: "/raw/writer/no",
        content: "\0",
      })
    ).error.code,
    "NOT_UTF8_TEXT",
  );
  assert.equal(
    (
      await call(f.memberClient, "create_file", {
        path: "/raw/writer/no",
        content: "\ud800",
      })
    ).error.code,
    "NOT_UTF8_TEXT",
  );
  assert.equal(
    (
      await call(f.memberClient, "search_content", {
        keywords: ["a", "b", "c"],
      })
    ).error.code,
    "INVALID_KEYWORDS",
  );
  assert.equal(
    (
      await call(f.memberClient, "search_content", {
        keywords: ["a"],
        limit: 2,
      })
    ).error.code,
    "INVALID_LIMIT",
  );
  const result = await call(f.memberClient, "search_content", {
    keywords: ["needle"],
    path: "/raw/writer",
  });
  assert.equal(result.results.length, 1);
  assert.equal(result.reason, "result_limit");
  assert.equal(result.complete, false);
  const first = await call(f.memberClient, "list_directory", {
    path: "/raw/writer",
  });
  const second = await call(f.memberClient, "list_directory", {
    path: "/raw/writer",
    cursor: first.nextCursor,
  });
  assert.equal(first.entries[0].name, "a");
  assert.equal(second.entries[0].name, "b");
});

test("search time budget returns an explicit partial result", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 100; i++)
    await writeFile(join(f.c.root, `agents/writer/raw/${i}`), "evidence");
  f.c.mcp.searchTimeoutMs = 1;
  await save(f.home, f.c);
  const result = await call(f.memberClient, "search_content", {
    keywords: ["missing"],
  });
  assert.equal(result.reason, "timeout");
  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
});

test("local key commands store only hashes and rotate/revoke without restarting MCP", async (t) => {
  const f = await fixture(t);
  const created = cli(f.dir, ["mcp", "key", "create", "--agent", "writer"]);
  assert.equal(created.ok, true);
  const config = await readFile(join(f.home, "config.json"), "utf8");
  assert.ok(!config.includes(created.data.token));
  assert.equal((await lstat(join(f.home, "config.json"))).mode & 0o077, 0);
  const listing = cli(f.dir, ["mcp", "key", "list"]);
  assert.ok(!JSON.stringify(listing).includes("hash"));
  assert.ok(!JSON.stringify(listing).includes(created.data.token));
  const client = await f.clientFor(created.data.token);
  const rotated = cli(f.dir, [
    "mcp",
    "key",
    "rotate",
    "--key",
    created.data.id,
  ]);
  assert.equal(rotated.ok, true);
  await assert.rejects(() => client.listTools());
  const next = await f.clientFor(rotated.data.token);
  assert.equal((await next.listTools()).tools.length, 8);
  assert.equal(
    cli(f.dir, ["mcp", "key", "revoke", "--key", rotated.data.id]).ok,
    true,
  );
  await assert.rejects(() => next.listTools());
  assert.equal(
    cli(f.dir, ["mcp", "key", "create", "--agent", "remote"]).error.code,
    "INVALID_BINDING",
  );
  assert.equal(
    cli(f.dir, [
      "mcp",
      "key",
      "create",
      "--agent",
      "writer",
      "--role",
      "leader",
    ]).error.code,
    "INVALID_BINDING",
  );
});

test("retiring, moving or changing the role of an identity invalidates its existing key", async (t) => {
  const f = await fixture(t),
    agent = f.c.agents[0];
  for (const patch of [
    { active: false },
    { deviceId: "new-writer" },
    { local: false },
    { role: "leader" },
  ]) {
    const before = { ...agent };
    Object.assign(agent, patch);
    await save(f.home, f.c);
    const response = await fetch(f.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.member.token}` },
    });
    assert.equal(response.status, 401);
    Object.assign(agent, before);
  }
});

test("HTTP requires bearer, validates Origin, limits bodies and exposes only /mcp", async (t) => {
  const f = await fixture(t);
  const headers = {
    Authorization: `Bearer ${f.member.token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  assert.equal((await fetch(f.url, { method: "POST" })).status, 401);
  assert.equal(
    (await fetch(f.url + "?token=secret", { method: "POST", headers })).status,
    404,
  );
  assert.equal(
    (
      await fetch(f.url, {
        method: "POST",
        headers: { ...headers, Origin: "https://untrusted.example" },
        body: "{}",
      })
    ).status,
    403,
  );
  f.c.mcp.publicUrl = "https://knowledge.example/mcp";
  await save(f.home, f.c);
  assert.equal(
    (
      await fetch(f.url, {
        method: "POST",
        headers: { ...headers, Origin: "https://knowledge.example" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      })
    ).status,
    200,
  );
  assert.equal((await fetch(f.url, { headers })).status, 405);
  assert.equal(
    (await fetch(f.url, { method: "POST", headers, body: "{" })).status,
    400,
  );
  assert.equal(
    (
      await fetch(f.url, {
        method: "POST",
        headers: { ...headers, "MCP-Protocol-Version": "1900-01-01" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      })
    ).status,
    400,
  );
  f.c.mcp.maxFileBytes = 1;
  await save(f.home, f.c);
  assert.equal(
    (await fetch(f.url, { method: "POST", headers, body: " ".repeat(70000) }))
      .status,
    413,
  );
  await assert.rejects(() => connect(f.url, "invalid"));
});

test("chunked oversized requests return 413 without losing the HTTP response", async (t) => {
  const f = await fixture(t);
  f.c.mcp.maxFileBytes = 1;
  await save(f.home, f.c);
  const { request } = await import("node:http");
  const status = await new Promise((resolve, reject) => {
    const req = request(
      f.url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${f.member.token}`,
          "Content-Type": "application/json",
          "Transfer-Encoding": "chunked",
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.write(" ".repeat(40000));
    req.end(" ".repeat(40000));
  });
  assert.equal(status, 413);
});

test("invalid MCP configuration is rejected before saving or starting services", async (t) => {
  const f = await fixture(t),
    before = await readFile(join(f.home, "config.json"), "utf8");
  for (const [args, code] of [
    [["--public-url", "not-a-url"], "INVALID_URL"],
    [["--public-url", "http://example.com/mcp"], "INVALID_URL"],
    [["--allowed-origins", "*"], "INVALID_ORIGIN"],
    [["--max-file-bytes=-1"], "INVALID_LIMIT"],
    [["--port", "65536"], "INVALID_PORT"],
  ]) {
    assert.equal(cli(f.dir, ["mcp", "enable", ...args]).error.code, code);
    assert.equal(await readFile(join(f.home, "config.json"), "utf8"), before);
  }
});

test("concurrent writes through case aliases cannot both overwrite one version", async (t) => {
  const f = await fixture(t),
    path = "/raw/writer/Case.md";
  await call(f.memberClient, "create_file", { path, content: "original" });
  const alternate = join(f.c.root, "agents/writer/raw/case.md");
  if (!(await lstat(alternate).catch(() => undefined))) {
    t.skip("Case-sensitive filesystem has no case aliases.");
    return;
  }
  const { version } = await call(f.memberClient, "read_file", { path });
  const results = await Promise.all(
    [path, "/raw/writer/case.md"].map((p, i) =>
      call(f.memberClient, "write_file", {
        path: p,
        content: `edit ${i}`,
        version,
      }),
    ),
  );
  assert.equal(results.filter((r) => !r.isError).length, 1);
  assert.equal(results.find((r) => r.isError).error.code, "VERSION_CONFLICT");
});

test("audit logs omit bearer tokens, text contents and search keywords", async (t) => {
  const f = await fixture(t);
  await call(f.memberClient, "create_file", {
    path: "/raw/writer/note",
    content: "unique-private-body",
  });
  await call(f.memberClient, "search_content", {
    keywords: ["unique-private-query"],
  });
  const log = await readFile(join(f.dir, "logs/mcp.log"), "utf8");
  for (const value of [
    f.member.token,
    "unique-private-body",
    "unique-private-query",
  ])
    assert.ok(!log.includes(value));
  const record = JSON.parse(log.trim().split("\n")[0]);
  assert.equal(record.agentId, "writer");
  assert.equal(record.operation, "create_file");
  assert.equal(record.outcome, "ok");
});
