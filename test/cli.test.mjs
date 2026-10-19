import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const cli = resolve("dist/cli.js");
test("an unregistered caller gets a structured error instead of choosing an identity", async () => {
  const home = await mkdtemp(join(tmpdir(), "kioku-context-"));
  try {
    const r = spawnSync(
      process.execPath,
      [cli, "status", "--home", home, "--json"],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 2);
    assert.equal(JSON.parse(r.stdout).error.code, "NOT_INITIALIZED");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("noninteractive setup rejects missing or unsafe inputs before creating dependencies", async () => {
  const home = await mkdtemp(join(tmpdir(), "kioku-input-"));
  try {
    for (const [args, code] of [
      [["init"], "MISSING_ARGUMENT"],
      [["status", "--unknown"], "USAGE"],
      [
        [
          "init",
          "--root",
          join(home, "elsewhere"),
          "--address",
          "127.0.0.1:22000",
          "--service",
          "manual",
        ],
        "INSTALL_ROOT_REQUIRED",
      ],
    ]) {
      const r = spawnSync(
        process.execPath,
        [cli, ...args, "--home", home, "--json"],
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
      );
      assert.equal(r.status, 2);
      assert.equal(JSON.parse(r.stdout).error.code, code);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("CLI help reports the installed package version", async () => {
  const pkg = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  const r = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.startsWith(`KiokuNet ${pkg.version} —`));
});
