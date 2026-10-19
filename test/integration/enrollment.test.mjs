import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli, ok, port } from "../helpers/node-cli.mjs";
import { removeFixture } from "../helpers/files.mjs";
test("node enrollment is signed and replay-safe without registering any spaces", async (t) => {
  const d = await realpath(await mkdtemp(join(tmpdir(), "kioku-enroll-v2-"))),
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
  ok(hub, ["invite", "--out", join(d, "invite")]);
  assert.equal(
    JSON.parse(await readFile(join(d, "invite"), "utf8")).payload.spaceId,
    undefined,
  );
  const joined = ok(node, [
    "join",
    "--invite",
    join(d, "invite"),
    "--out",
    join(d, "receipt"),
    "--service",
    "manual",
  ]);
  for (let i = 0; i < 2; i++)
    ok(hub, ["enroll", "--receipt", join(d, "receipt")]);
  assert.deepEqual(ok(node, ["space", "list"]).spaces, []);
  assert.equal(ok(hub, ["node", "list"]).nodes.length, 2);
  for (const id of ["notes", "research"])
    ok(node, ["space", "add", "--space", id]);
  assert.equal(ok(node, ["space", "list"]).spaces.length, 2);
  const forged = JSON.parse(await readFile(join(d, "receipt"), "utf8"));
  forged.payload.deviceId = "forged";
  await writeFile(join(d, "forged"), JSON.stringify(forged));
  assert.equal(
    cli(hub, ["enroll", "--receipt", join(d, "forged")]).error.code,
    "INVALID_SIGNATURE",
  );
  ok(hub, [
    "node",
    "revoke",
    "--device",
    joined.deviceId,
    "--confirm",
    joined.deviceId,
  ]);
  assert.equal(
    cli(hub, ["enroll", "--receipt", join(d, "receipt")]).error.code,
    "REVOKED_OR_CHANGED_DEVICE",
  );
  for (const old of ["agent", "source", "workspace", "context"])
    assert.equal(cli(hub, [old, "list"]).error.code, "USAGE");
});
