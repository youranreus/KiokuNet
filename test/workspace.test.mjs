import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const cli = resolve("dist/cli.js");

test("workspace attachment requires an initialized node before exposing directories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kioku-workspace-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "workspace",
        "attach",
        "--source",
        join(dir, "source"),
        "--raw-path",
        join(dir, "memory"),
        "--shared-path",
        join(dir, "shared"),
        "--home",
        join(dir, "config"),
        "--json",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).error.code, "NOT_INITIALIZED");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
