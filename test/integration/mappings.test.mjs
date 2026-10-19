import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  unlink,
  symlink,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli, ok, port } from "../helpers/node-cli.mjs";
import { removeFixture } from "../helpers/files.mjs";
test("CLI space mapping rejects existing directories and sync control files cannot redirect writes into Shared", async (t) => {
  const d = await realpath(await mkdtemp(join(tmpdir(), "kioku-map-cli-"))),
    home = join(d, "hub");
  t.after(() => removeFixture(d));
  const init = [
    "init",
    "--address",
    `127.0.0.1:${await port()}`,
    "--service",
    "manual",
  ];
  ok(home, init);
  ok(home, ["space", "add", "--space", "notes"]);
  const existing = join(d, "existing");
  await mkdir(existing);
  await writeFile(join(existing, "keep.md"), "keep");
  assert.equal(
    cli(home, ["space", "map", "--space", "notes", "--path", existing]).error
      .code,
    "OUTPUT_EXISTS",
  );
  const mapped = join(d, "mapped");
  ok(home, ["space", "map", "--space", "notes", "--path", mapped]);
  await writeFile(join(mapped, "note.md"), "content");
  ok(home, ["space", "unmap", "--path", mapped]);
  assert.equal(
    await readFile(join(home, "data/spaces/notes/note.md"), "utf8"),
    "content",
  );
  const target = join(home, "data/shared/keep.md"),
    ignore = join(home, "data/spaces/notes/.stignore");
  await writeFile(target, "safe");
  for (const redirect of [symlink, link]) {
    await unlink(ignore);
    await redirect(target, ignore);
    assert.equal(cli(home, init).error.code, "UNSAFE_FILE");
    assert.equal(await readFile(target, "utf8"), "safe");
  }
});
