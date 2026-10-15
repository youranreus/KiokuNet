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

test("a link cannot substitute for isolation from the infrastructure account", async () => {
  const dir = await mkdtemp(
    join(
      process.platform === "darwin" ? "/private/tmp" : tmpdir(),
      "kioku-workspace-",
    ),
  );
  const home = join(dir, "config"),
    root = join(dir, "data"),
    workspace = join(dir, "project");
  try {
    await mkdir(workspace);
    const init = call(home, [
      "init",
      "--agent",
      "leader",
      "--root",
      root,
      "--address",
      "127.0.0.1:23090",
      "--service",
      "manual",
    ]);
    assert.equal(init.ok, true, JSON.stringify(init));
    const result = call(home, [
      "workspace",
      "attach",
      "--source",
      join(root, "agents/leader/raw"),
      "--raw-path",
      join(workspace, "memory"),
      "--shared-path",
      join(workspace, "shared"),
      "--all-raw-path",
      join(workspace, "sources"),
      "--user",
      userInfo().username,
    ]);
    assert.equal(result.ok, false);
    assert.equal(
      result.error.code,
      "ISOLATION_REQUIRED",
      JSON.stringify(result),
    );
    await assert.rejects(access(join(workspace, "memory")), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("attachment never replaces an existing workspace directory", async () => {
  const dir = await mkdtemp(
    join(
      process.platform === "darwin" ? "/private/tmp" : tmpdir(),
      "kioku-workspace-",
    ),
  );
  const home = join(dir, "config"),
    root = join(dir, "data"),
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
    await rm(dir, { recursive: true, force: true });
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
    root = join(dir, "data"),
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
    // A disposable writable Raw fixture exercises mapping without changing OS
    // ownership. Real ownership and denied writes are covered in the root test.
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
    await symlink(join(root, "shared"), shared);
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
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "OS permissions enforce member read-only shared and Leader read-only other Raw",
  {
    skip:
      process.getuid?.() !== 0
        ? "Requires root to exercise two real unprivileged OS identities"
        : false,
  },
  async () => {
    const { chmod, chown } = await import("node:fs/promises");
    const dir = await mkdtemp(
      join(
        process.platform === "darwin" ? "/private/tmp" : tmpdir(),
        "kioku-accounts-",
      ),
    );
    const home = join(dir, "config"),
      root = join(dir, "data");
    const identity = (user, flag) =>
      Number(
        spawnSync("/usr/bin/id", [flag, user], {
          encoding: "utf8",
        }).stdout.trim(),
      );
    const member = {
      user: "nobody",
      uid: identity("nobody", "-u"),
      gid: identity("nobody", "-g"),
    };
    const leader = {
      user: "daemon",
      uid: identity("daemon", "-u"),
      gid: identity("daemon", "-g"),
    };
    const execute = (account, body, paths) => {
      const script = `const fs = require('node:fs'); const assert = require('node:assert/strict');
      process.setgroups([]); process.setgid(${account.gid}); process.setuid(${account.uid});
      const p = ${JSON.stringify(paths)}; ${body}`;
      const result = spawnSync(process.execPath, ["-e", script], {
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
    };
    try {
      await chmod(dir, 0o755);
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
      const own = join(root, "agents/writer/raw"),
        leadRaw = join(root, "agents/leader/raw"),
        sharedSource = join(root, "shared");
      await chown(own, member.uid, member.gid);
      await chmod(own, 0o755);
      await chown(leadRaw, leader.uid, leader.gid);
      await chmod(leadRaw, 0o755);
      // Public document ownership belongs to the trusted Leader, not the member.
      const makeLeaderOwned = async (path) => {
        const { readdir, lstat } = await import("node:fs/promises");
        await chown(path, leader.uid, leader.gid);
        if ((await lstat(path)).isDirectory())
          for (const name of await readdir(path))
            await makeLeaderOwned(join(path, name));
      };
      await makeLeaderOwned(sharedSource);
      for (const [a, source] of [
        [member, own],
        [leader, leadRaw],
      ]) {
        const project = join(dir, a.user);
        await mkdir(project, { mode: 0o755 });
        await chown(project, a.uid, a.gid);
        const result = call(home, [
          "workspace",
          "attach",
          "--source",
          source,
          "--raw-path",
          join(project, "memory"),
          "--shared-path",
          join(project, "shared"),
          "--user",
          a.user,
          ...(a === leader ? ["--all-raw-path", join(project, "sources")] : []),
        ]);
        assert.equal(result.ok, true, JSON.stringify(result));
      }
      execute(
        member,
        `
      assert.match(fs.readFileSync(p.shared + '/INDEX.md', 'utf8'), /Shared knowledge/);
      for (const base of [p.shared, p.source]) {
        for (const action of [() => fs.writeFileSync(base + '/new.md', 'bad'),
          () => fs.appendFileSync(base + '/INDEX.md', 'bad'),
          () => fs.unlinkSync(base + '/INDEX.md'),
          () => fs.renameSync(base + '/INDEX.md', base + '/renamed.md'),
          () => fs.chmodSync(base, 0o777), () => fs.chmodSync(base + '/INDEX.md', 0o666)])
          assert.throws(action, e => ['EACCES', 'EPERM', 'EROFS'].includes(e.code));
      }
      assert.throws(() => fs.readFileSync(p.home + '/config.json'), e => ['EACCES', 'EPERM'].includes(e.code));
      fs.writeFileSync(p.raw + '/draft.md', 'first'); fs.writeFileSync(p.raw + '/draft.md', 'edited');
      fs.renameSync(p.raw + '/draft.md', p.raw + '/final.md');
      assert.equal(fs.readFileSync(p.raw + '/final.md', 'utf8'), 'edited'); fs.unlinkSync(p.raw + '/final.md');
      fs.writeFileSync(p.raw + '/source.md', 'member knowledge', { mode: 0o644 });
    `,
        {
          shared: join(dir, "nobody/shared"),
          source: sharedSource,
          raw: join(dir, "nobody/memory"),
          home,
        },
      );
      execute(
        leader,
        `
      assert.equal(fs.readFileSync(p.other + '/source.md', 'utf8'), 'member knowledge');
      assert.throws(() => fs.writeFileSync(p.other + '/source.md', 'bad'), e => ['EACCES', 'EPERM'].includes(e.code));
      assert.throws(() => fs.unlinkSync(p.other + '/source.md'), e => ['EACCES', 'EPERM'].includes(e.code));
      fs.writeFileSync(p.shared + '/new.md', 'public knowledge', { mode: 0o644 });
    `,
        {
          other: join(dir, "daemon/sources/writer/raw"),
          shared: join(dir, "daemon/shared"),
        },
      );
      execute(
        member,
        `
      assert.equal(fs.readFileSync(p.shared + '/new.md', 'utf8'), 'public knowledge');
      assert.throws(() => fs.writeFileSync(p.shared + '/new.md', 'bad'), e => ['EACCES', 'EPERM'].includes(e.code));
    `,
        { shared: join(dir, "nobody/shared") },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("writable Raw cannot redirect infrastructure control-file writes into shared", async () => {
  const { unlink, symlink, link } = await import("node:fs/promises");
  const dir = await mkdtemp(
    join(
      process.platform === "darwin" ? "/private/tmp" : tmpdir(),
      "kioku-control-",
    ),
  );
  const home = join(dir, "config"),
    root = join(dir, "data");
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
    const target = join(root, "shared/INDEX.md"),
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
    await rm(dir, { recursive: true, force: true });
  }
});
