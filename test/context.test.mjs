import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const cli = resolve("dist/cli.js");
test("an unregistered caller gets a structured error instead of choosing an identity", async () => {
  const home = await mkdtemp(join(tmpdir(), "kioku-context-"));
  try {
    const r = spawnSync(
      process.execPath,
      [cli, "context", "--home", home, "--json"],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 2);
    assert.equal(JSON.parse(r.stdout).error.code, "NOT_INITIALIZED");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
