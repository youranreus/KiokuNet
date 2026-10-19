import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "kioku-layout-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const shared = join(home, "data/shared");
  return {
    shared,
    init() {
      const result = spawnSync(
        process.execPath,
        [
          resolve("dist/cli.js"),
          "init",
          "--home",
          home,
          "--address",
          "127.0.0.1:23671",
          "--service",
          "manual",
          "--json",
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            KIOKU_SYNCTHING:
              process.env.KIOKU_SYNCTHING || resolve(".tools/syncthing"),
          },
        },
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(JSON.parse(result.stdout).ok, true);
    },
  };
}

async function knowledgeSnapshot(shared) {
  const entries = (await readdir(shared, { recursive: true })).filter(
    (path) => !path.split(/[\\/]/).some((name) => name.startsWith(".")),
  );
  const files = {};
  for (const path of entries.filter((name) => name.endsWith(".md")).sort())
    files[path] = await readFile(join(shared, path), "utf8");
  return { entries: entries.sort(), files };
}

test("Shared starts without imposing a knowledge taxonomy and preserves user organization", async (t) => {
  const f = await fixture(t);
  f.init();
  assert.deepEqual((await knowledgeSnapshot(f.shared)).entries, []);
  await mkdir(join(f.shared, "my-category"));
  await writeFile(join(f.shared, "my-category", "notes.md"), "user content");
  const before = await knowledgeSnapshot(f.shared);
  f.init();
  assert.deepEqual(await knowledgeSnapshot(f.shared), before);
});

for (const withIndex of [true, false]) {
  test(`initialization preserves legacy content ${withIndex ? "with" : "without"} a root index`, async (t) => {
    const f = await fixture(t);
    for (const [path, content] of [
      ...(withIndex ? [["INDEX.md", "# Existing index\n"]] : []),
      ["profile/user.md", "Existing personal facts\n"],
      ["projects/project.md", "Existing project context\n"],
      ["topics/research.md", "Existing research\n"],
    ]) {
      await mkdir(dirname(join(f.shared, path)), { recursive: true });
      await writeFile(join(f.shared, path), content);
    }
    const before = await knowledgeSnapshot(f.shared);
    f.init();
    assert.deepEqual(await knowledgeSnapshot(f.shared), before);
    f.init();
    assert.deepEqual(await knowledgeSnapshot(f.shared), before);
  });
}
