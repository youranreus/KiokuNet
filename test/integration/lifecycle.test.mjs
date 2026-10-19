import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  writeFile,
  readFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, save } from "../../dist/core.js";
import { cli, ok, port } from "../helpers/node-cli.mjs";
import { removeFixture } from "../helpers/files.mjs";
test("space ownership migration preserves identity, resumes seed copying, and can return to the original Hub", async (t) => {
  const d = await realpath(await mkdtemp(join(tmpdir(), "kioku-move-v2-"))),
    hub = join(d, "hub"),
    node = join(d, "node");
  t.after(() => removeFixture(d));
  ok(hub, [
    "init",
    "--address",
    `127.0.0.1:${await port()}`,
    "--service",
    "manual",
  ]);
  for (const id of ["notes", "research"])
    ok(hub, ["space", "add", "--space", id]);
  const config = await load(join(hub, "config"));
  const retainedId = `kioku-${config.networkId}-raw-notes`;
  config.spaces.find((s) => s.id === "notes").syncFolderId = retainedId;
  await save(join(hub, "config"), config);
  await writeFile(join(hub, "data/spaces/notes/keep.md"), "keep me");
  const bundle = join(d, "bundle");
  ok(hub, [
    "space",
    "migrate",
    "--space",
    "notes",
    "--target",
    bundle,
    "--confirm",
    "notes",
  ]);
  assert.equal(ok(hub, ["space", "info", "--space", "notes"]).active, false);
  ok(hub, [
    "space",
    "migrate",
    "--receipt",
    join(bundle, "migration.json"),
    "--out",
    join(d, "invite"),
    "--confirm",
    "notes",
  ]);
  assert.equal(
    cli(node, [
      "join",
      "--invite",
      join(d, "invite"),
      "--out",
      join(d, "receipt"),
      "--service",
      "manual",
    ]).error.code,
    "MIGRATION_SEED_REQUIRED",
  );
  await mkdir(join(node, "data/spaces/notes"), { recursive: true });
  await writeFile(join(node, "data/spaces/notes/keep.md"), "keep me");
  ok(node, [
    "join",
    "--invite",
    join(d, "invite"),
    "--out",
    join(d, "receipt"),
    "--service",
    "manual",
    "--seed",
    bundle,
  ]);
  ok(hub, ["enroll", "--receipt", join(d, "receipt")]);
  assert.equal(
    ok(node, ["space", "info", "--space", "notes"]).syncFolderId,
    retainedId,
  );
  assert.equal(ok(hub, ["space", "info", "--space", "notes"]).local, false);
  await writeFile(join(node, "data/spaces/notes/later.md"), "later");
  const back = join(d, "back");
  ok(node, [
    "space",
    "migrate",
    "--space",
    "notes",
    "--target",
    back,
    "--confirm",
    "notes",
  ]);
  ok(hub, [
    "space",
    "migrate",
    "--receipt",
    join(back, "migration.json"),
    "--out",
    join(d, "back-invite"),
    "--confirm",
    "notes",
  ]);
  assert.equal(
    cli(hub, ["enroll", "--receipt", join(d, "receipt")]).error.code,
    "UNKNOWN_INVITATION",
  );
  ok(hub, [
    "join",
    "--invite",
    join(d, "back-invite"),
    "--out",
    join(d, "back-receipt"),
    "--seed",
    back,
    "--service",
    "manual",
  ]);
  assert.equal(ok(hub, ["space", "info", "--space", "notes"]).local, true);
  assert.equal(
    await readFile(join(hub, "data/spaces/notes/later.md"), "utf8"),
    "later",
  );
});
