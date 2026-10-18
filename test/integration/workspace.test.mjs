import { removeFixture } from "../helpers/files.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  access,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const cli = resolve("dist/cli.js");
function call(home, args) {
  const result = spawnSync(
    process.execPath,
    [cli, ...args, "--home", home, "--json"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        KIOKU_SYNCTHING:
          process.env.KIOKU_SYNCTHING || resolve(".tools/syncthing"),
      },
    },
  );
  assert.ok(result.stdout, result.stderr);
  return JSON.parse(result.stdout);
}

test("attachment never replaces an existing workspace directory", async () => {
  const dir = await mkdtemp(
    join(
      process.platform === "darwin" ? "/private/tmp" : tmpdir(),
      "kioku-workspace-",
    ),
  );
  const home = join(dir, "config"),
    root = join(home, "data"),
    memory = join(dir, "memory");
  try {
    await mkdir(memory);
    await writeFile(join(memory, "keep.md"), "existing knowledge");
    assert.equal(
      call(home, [
        "init",
        "--agent",
        "leader",
        "--root",
        root,
        "--address",
        "127.0.0.1:23090",
        "--service",
        "manual",
      ]).ok,
      true,
    );
    const result = call(home, [
      "workspace",
      "attach",
      "--source",
      join(root, "agents/leader/raw"),
      "--raw-path",
      memory,
      "--shared-path",
      join(dir, "shared"),
      "--all-raw-path",
      join(dir, "sources"),
      "--user",
      "nobody",
    ]);
    assert.equal(result.error?.code, "OUTPUT_EXISTS", JSON.stringify(result));
    assert.equal(
      await readFile(join(memory, "keep.md"), "utf8"),
      "existing knowledge",
    );
  } finally {
    await removeFixture(dir);
  }
});

test("directory mappings are repeatable, preserve files and refuse changed entries on detach", async () => {
  const { chmod, symlink, unlink, readlink } = await import("node:fs/promises");
  const dir = await mkdtemp(
    join(
      process.platform === "darwin" ? "/private/tmp" : tmpdir(),
      "kioku-workspace-",
    ),
  );
  const home = join(dir, "config"),
    root = join(home, "data"),
    project = join(dir, "project");
  try {
    await chmod(dir, 0o755);
    await mkdir(project, { mode: 0o755 });
    assert.equal(
      call(home, [
        "init",
        "--agent",
        "leader",
        "--root",
        root,
        "--address",
        "127.0.0.1:23090",
        "--service",
        "manual",
      ]).ok,
      true,
    );
    const invite = join(dir, "invite.json");
    assert.equal(
      call(home, ["invite", "--agent", "writer", "--out", invite]).ok,
      true,
    );
    assert.equal(
      call(home, [
        "agent",
        "add",
        "--invite",
        invite,
        "--out",
        join(dir, "receipt.json"),
      ]).ok,
      true,
    );
    const source = join(root, "agents/writer/raw"),
      raw = join(project, "notes"),
      shared = join(project, "knowledge");
    // The same account manages workspace links; readonly shared copies are
    // exercised by machine-access.test.mjs without privileged account switching.
    await chmod(source, 0o777);
    const args = [
      "workspace",
      "attach",
      "--source",
      source,
      "--raw-path",
      raw,
      "--shared-path",
      shared,
      "--user",
      "nobody",
    ];
    for (let i = 0; i < 2; i++) {
      const result = call(home, args);
      assert.equal(result.ok, true, JSON.stringify(result));
    }
    assert.equal(call(home, ["workspace", "list"]).data.workspaces.length, 1);
    assert.equal(call(home, ["workspace", "check"]).data.healthy, true);
    await writeFile(join(raw, "notes.md"), "edited through the workspace");
    assert.equal(
      await readFile(join(source, "notes.md"), "utf8"),
      "edited through the workspace",
    );
    await unlink(shared);
    await mkdir(shared);
    assert.equal(
      call(home, ["workspace", "detach", "--raw-path", raw]).error.code,
      "WORKSPACE_CHANGED",
    );
    assert.equal(await readlink(raw), source);
    await rm(shared, { recursive: true });
    await symlink(join(home, "views/shared"), shared);
    assert.equal(
      call(home, ["workspace", "detach", "--raw-path", raw]).data.detached,
      true,
    );
    assert.equal(
      call(home, ["workspace", "detach", "--raw-path", raw]).data.detached,
      false,
    );
    await assert.rejects(access(raw), { code: "ENOENT" });
    assert.equal(
      await readFile(join(source, "notes.md"), "utf8"),
      "edited through the workspace",
    );
  } finally {
    await removeFixture(dir);
  }
});

test("writable Raw cannot redirect infrastructure control-file writes into shared", async () => {
  const { unlink, symlink, link } = await import("node:fs/promises");
  const dir = await mkdtemp(
    join(
      process.platform === "darwin" ? "/private/tmp" : tmpdir(),
      "kioku-control-",
    ),
  );
  const home = join(dir, "config"),
    root = join(home, "data");
  const init = [
    "init",
    "--agent",
    "leader",
    "--root",
    root,
    "--address",
    "127.0.0.1:23090",
    "--service",
    "manual",
  ];
  try {
    assert.equal(call(home, init).ok, true);
    const target = join(root, "shared/Index.md"),
      ignore = join(root, "agents/leader/raw/.stignore");
    const original = await readFile(target, "utf8");
    for (const redirect of [symlink, link]) {
      await unlink(ignore);
      await redirect(target, ignore);
      const result = call(home, init);
      assert.equal(result.error?.code, "UNSAFE_FILE", JSON.stringify(result));
      assert.equal(await readFile(target, "utf8"), original);
    }
  } finally {
    await removeFixture(dir);
  }
});
