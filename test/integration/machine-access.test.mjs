import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export function call(home, args) {
  const env = { ...process.env, KIOKU_SYNCTHING: resolve(".tools/syncthing") };
  delete env.KIOKU_SPACE_ID;
  const r = spawnSync(
    process.execPath,
    [resolve("dist/cli.js"), ...args, "--home", home, "--json"],
    { encoding: "utf8", env },
  );
  assert.ok(r.stdout, r.stderr);
  return JSON.parse(r.stdout);
}

test("a Hub can exist without any space and keeps its files under one installation root", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "kioku-machine-")));
  try {
    const result = call(home, [
      "init",
      "--address",
      "127.0.0.1:23541",
      "--service",
      "manual",
    ]);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.root, join(home, "data"));
    assert.deepEqual(call(home, ["space", "list"]).data.spaces, []);
    assert.equal(
      call(home, ["space", "info", "--space", "missing"]).error.code,
      "UNKNOWN_SPACE",
    );
    const config = JSON.parse(
      await readFile(join(home, "config/config.json"), "utf8"),
    );
    assert.equal(config.sync.home, join(home, "state/syncthing"));
    assert.equal(
      call(home, [
        "init",
        "--address",
        "127.0.0.1:23541",
        "--service",
        "manual",
      ]).ok,
      true,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("machine pairing is independent of spaces; trusted nodes create spaces offline without another invitation", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "kioku-pair-")));
  const hub = join(dir, "hub"),
    node = join(dir, "node");
  try {
    assert.equal(
      call(hub, ["init", "--address", "127.0.0.1:23542", "--service", "manual"])
        .ok,
      true,
    );
    assert.equal(call(hub, ["invite", "--out", join(dir, "invite")]).ok, true);
    const invitation = JSON.parse(await readFile(join(dir, "invite"), "utf8"));
    assert.equal(invitation.payload.spaceId, undefined);
    const joined = call(node, [
      "join",
      "--invite",
      join(dir, "invite"),
      "--out",
      join(dir, "receipt"),
      "--service",
      "manual",
    ]);
    assert.equal(joined.ok, true, JSON.stringify(joined));
    assert.deepEqual(call(node, ["space", "list"]).data.spaces, []);
    assert.equal(
      call(hub, ["enroll", "--receipt", join(dir, "receipt")]).ok,
      true,
    );
    assert.equal(
      call(hub, ["enroll", "--receipt", join(dir, "receipt")]).ok,
      true,
    );
    for (const id of ["writer", "research"]) {
      const added = call(node, ["space", "add", "--space", id]);
      assert.equal(added.ok, true, JSON.stringify(added));
      assert.equal(added.data.registration, "pending");
    }
    assert.equal(call(node, ["space", "list"]).data.spaces.length, 2);
    const added = call(hub, ["space", "add", "--space", "hub-notes"]);
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.equal(added.data.registration, "registered");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "background refresh preserves the last readable copy on failure and recovers without reattachment",
  { timeout: 30000 },
  async () => {
    const { mkdir, writeFile, symlink, unlink, chmod, readdir, lstat } =
      await import("node:fs/promises");
    const { createServer } = await import("node:net");
    const port = await new Promise((resolvePort) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const p = server.address().port;
        server.close(() => resolvePort(p));
      });
    });
    const dir = await realpath(await mkdtemp(join(tmpdir(), "kioku-refresh-"))),
      home = join(dir, "hub"),
      project = join(dir, "project");
    async function wait(fn) {
      for (let i = 0; i < 70; i++) {
        try {
          return await fn();
        } catch (e) {
          if (i === 69) throw e;
          await new Promise((r) => setTimeout(r, 150));
        }
      }
    }
    try {
      await mkdir(project);
      assert.equal(
        call(home, [
          "init",
          "--address",
          `127.0.0.1:${port}`,
          "--service",
          "manual",
        ]).ok,
        true,
      );
      assert.equal(call(home, ["space", "add", "--space", "writer"]).ok, true);
      assert.equal(
        call(home, ["shared", "map", "--path", join(project, "shared")]).ok,
        true,
      );
      assert.equal(call(home, ["service", "start"]).ok, true);
      await writeFile(join(home, "data/shared/live.md"), "first");
      await wait(async () =>
        assert.equal(
          await readFile(join(project, "shared/live.md"), "utf8"),
          "first",
        ),
      );
      await symlink(join(dir, "missing"), join(home, "data/shared/broken"));
      await wait(() => assert.ok(call(home, ["status"]).data.view.error));
      assert.equal(
        await readFile(join(project, "shared/live.md"), "utf8"),
        "first",
      );
      assert.ok(call(home, ["status"]).data.view.lastSuccess);
      await unlink(join(home, "data/shared/broken"));
      await writeFile(join(home, "data/shared/live.md"), "second");
      await wait(async () =>
        assert.equal(
          await readFile(join(project, "shared/live.md"), "utf8"),
          "second",
        ),
      );
      await wait(() =>
        assert.equal(call(home, ["status"]).data.view.error, undefined),
      );
      assert.equal(call(home, ["service", "stop"]).ok, true);
      assert.equal(
        await readFile(join(project, "shared/live.md"), "utf8"),
        "second",
      );
    } finally {
      call(home, ["service", "stop"]);
      async function writable(p) {
        const s = await lstat(p);
        if (s.isSymbolicLink()) return;
        if (s.isDirectory()) {
          await chmod(p, 0o700);
          for (const n of await readdir(p)) await writable(join(p, n));
        }
      }
      await writable(dir);
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "paired machines automatically register offline spaces, reject writer conflicts and distribute readonly shared",
  { timeout: 120000 },
  async () => {
    const { mkdir, writeFile, chmod, readdir, lstat } = await import(
      "node:fs/promises"
    );
    const { createServer } = await import("node:net");
    async function port() {
      return new Promise((r) => {
        const s = createServer();
        s.listen(0, "127.0.0.1", () => {
          const p = s.address().port;
          s.close(() => r(p));
        });
      });
    }
    async function wait(fn) {
      for (let i = 0; i < 150; i++) {
        try {
          return await fn();
        } catch (e) {
          if (i === 149) throw e;
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    }
    const dir = await realpath(
        await mkdtemp(join(tmpdir(), "kioku-registration-")),
      ),
      hub = join(dir, "hub"),
      node = join(dir, "node"),
      project = join(dir, "project");
    try {
      await mkdir(project);
      assert.equal(
        call(hub, [
          "init",
          "--address",
          `127.0.0.1:${await port()}`,
          "--service",
          "manual",
        ]).ok,
        true,
      );
      assert.equal(call(hub, ["space", "add", "--space", "reserved"]).ok, true);
      assert.equal(
        call(hub, ["invite", "--out", join(dir, "invite")]).ok,
        true,
      );
      assert.equal(
        call(node, [
          "join",
          "--invite",
          join(dir, "invite"),
          "--out",
          join(dir, "receipt"),
          "--service",
          "manual",
          "--listen-port",
          String(await port()),
        ]).ok,
        true,
      );
      assert.equal(
        call(hub, ["enroll", "--receipt", join(dir, "receipt")]).ok,
        true,
      );
      for (const id of ["writer", "reserved"])
        assert.equal(call(node, ["space", "add", "--space", id]).ok, true);
      await writeFile(
        join(node, "data/spaces/writer/offline.md"),
        "written offline",
      );
      const attach = ["shared", "map", "--path", join(project, "shared")];
      assert.equal(call(node, attach).error.code, "VIEW_UNAVAILABLE");
      // A temporary local disk obstacle must not permanently acknowledge a
      // registration whose Syncthing folder has never been configured.
      const marker = join(node, "data/spaces/writer/.stfolder");
      await writeFile(marker, "temporary obstacle");
      assert.equal(call(hub, ["service", "start"]).ok, true);
      assert.equal(call(node, ["service", "start"]).ok, true);
      await wait(() =>
        assert.match(call(node, ["status"]).data.worker.error || "", /EEXIST/),
      );
      assert.equal(
        call(node, ["space", "list"]).data.spaces.find((a) => a.id === "writer")
          .registration,
        "pending",
      );
      await rm(marker);
      await wait(() =>
        assert.equal(
          call(node, ["space", "list"]).data.spaces.find(
            (a) => a.id === "writer",
          ).registration,
          "registered",
        ),
      );
      await wait(() =>
        assert.equal(
          call(node, ["space", "list"]).data.spaces.find(
            (a) => a.id === "reserved",
          ).registration,
          "conflict",
        ),
      );
      await wait(async () =>
        assert.equal(
          await readFile(join(hub, "data/spaces/writer/offline.md"), "utf8"),
          "written offline",
        ),
      );
      assert.equal(
        call(hub, ["space", "list"]).data.spaces.find(
          (a) => a.id === "reserved",
        ).local,
        true,
      );
      await wait(() => assert.equal(call(node, attach).ok, true));
      await writeFile(join(hub, "data/shared/decision.md"), "shared decision");
      await wait(async () =>
        assert.equal(
          await readFile(join(project, "shared/decision.md"), "utf8"),
          "shared decision",
        ),
      );
      assert.equal(call(node, ["space", "add", "--space", "second"]).ok, true);
      await writeFile(
        join(node, "data/spaces/second/online.md"),
        "no second invitation",
      );
      await wait(async () =>
        assert.equal(
          await readFile(join(hub, "data/spaces/second/online.md"), "utf8"),
          "no second invitation",
        ),
      );
    } finally {
      for (const home of [node, hub]) call(home, ["service", "stop"]);
      async function writable(p) {
        const s = await lstat(p);
        if (s.isSymbolicLink()) return;
        if (s.isDirectory()) {
          await chmod(p, 0o700);
          for (const n of await readdir(p)) await writable(join(p, n));
        }
      }
      await writable(dir);
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "an unexpected Syncthing signal makes its supervisor exit with failure",
  { timeout: 20000 },
  async () => {
    const { spawn, execFileSync } = await import("node:child_process");
    const { once } = await import("node:events");
    const { removeFixture } = await import("../helpers/files.mjs");
    const home = await realpath(
      await mkdtemp(join(tmpdir(), "kioku-worker-exit-")),
    );
    let worker;
    let finished;
    try {
      assert.equal(
        call(home, [
          "init",
          "--address",
          "127.0.0.1:23545",
          "--service",
          "manual",
        ]).ok,
        true,
      );
      worker = spawn(
        process.execPath,
        [resolve("dist/worker.js"), join(home, "config")],
        { stdio: "ignore" },
      );
      finished = once(worker, "exit");
      for (let i = 0; i < 100; i++) {
        if (call(home, ["status"]).data.sync.running) break;
        assert.equal(worker.exitCode, null);
        if (i === 99) assert.fail("Syncthing did not start");
        await new Promise((r) => setTimeout(r, 100));
      }
      const pid = Number(
        execFileSync("pgrep", ["-P", String(worker.pid)], {
          encoding: "utf8",
        }).trim(),
      );
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      process.kill(pid, "SIGKILL");
      const [code, signal] = await finished;
      assert.equal(signal, null);
      assert.ok(code > 0, "native Restart=on-failure requires a nonzero exit");
    } finally {
      if (worker && worker.exitCode === null && worker.signalCode === null)
        worker.kill("SIGTERM");
      if (finished) await finished;
      await removeFixture(home);
    }
  },
);

test("concurrent CLI space creation shares the configuration lock without losing a space", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "kioku-concurrent-")),
  );
  try {
    assert.equal(
      call(home, [
        "init",
        "--address",
        "127.0.0.1:23544",
        "--service",
        "manual",
      ]).ok,
      true,
    );
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        exec(process.execPath, [
          resolve("dist/cli.js"),
          "space",
          "add",
          "--space",
          `space-${i}`,
          "--home",
          home,
          "--json",
        ]),
      ),
    );
    for (const r of results) assert.equal(JSON.parse(r.stdout).ok, true);
    assert.equal(call(home, ["space", "list"]).data.spaces.length, 6);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
