import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
const cli = resolve("dist/cli.js");
function call(home, args) {
  const env = {
    ...process.env,
    KIOKU_SYNCTHING: process.env.KIOKU_SYNCTHING || resolve(".tools/syncthing"),
    KIOKU_RCLONE: process.env.KIOKU_RCLONE || resolve(".tools/rclone"),
  };
  delete env.KIOKU_AGENT_ID;
  try {
    return JSON.parse(
      execFileSync(process.execPath, [cli, ...args, "--home", home, "--json"], {
        env,
        encoding: "utf8",
      }),
    );
  } catch (e) {
    return JSON.parse(e.stdout);
  }
}
test("a completed snapshot restores historical bytes to a fresh directory without touching live knowledge", async () => {
  const d = await mkdtemp(join(tmpdir(), "kioku-backup-")),
    home = join(d, "home"),
    root = join(d, "knowledge"),
    remote = join(d, "remote"),
    restored = join(d, "restored");
  try {
    assert.equal(
      call(home, [
        "init",
        "--agent",
        "leader",
        "--root",
        root,
        "--address",
        "127.0.0.1:23123",
        "--service",
        "manual",
      ]).ok,
      true,
    );
    await writeFile(
      join(root, "shared/projects/example.md"),
      "original record\n",
    );
    assert.equal(
      call(home, ["backup", "configure", "--target", remote]).ok,
      true,
    );
    const snap = call(home, ["backup", "run"]);
    assert.equal(snap.ok, true, JSON.stringify(snap));
    await writeFile(
      join(root, "shared/projects/example.md"),
      "current record\n",
    );
    assert.equal(
      call(home, [
        "backup",
        "restore",
        "--snapshot",
        snap.data.id,
        "--target",
        root,
      ]).error.code,
      "RESTORE_TARGET_EXISTS",
    );
    assert.equal(
      call(home, [
        "backup",
        "restore",
        "--snapshot",
        snap.data.id,
        "--target",
        restored,
      ]).ok,
      true,
    );
    assert.equal(
      await readFile(join(restored, "shared/projects/example.md"), "utf8"),
      "original record\n",
    );
    assert.equal(
      await readFile(join(root, "shared/projects/example.md"), "utf8"),
      "current record\n",
    );
    assert.equal(call(home, ["backup", "list"]).data.snapshots.length, 1);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});
