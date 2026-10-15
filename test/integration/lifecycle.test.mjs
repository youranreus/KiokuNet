import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
const cli = resolve("dist/cli.js");
function call(home, args, extra = {}) {
  const env = {
    ...process.env,
    KIOKU_SYNCTHING: process.env.KIOKU_SYNCTHING || resolve(".tools/syncthing"),
  };
  delete env.KIOKU_AGENT_ID;
  Object.assign(env, extra);
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
test("multiple identities require a binding, and migration seeds the new writer before enrollment", async () => {
  const d = await mkdtemp(join(tmpdir(), "kioku-lifecycle-")),
    h = join(d, "hub"),
    old = join(d, "old"),
    fresh = join(d, "fresh");
  try {
    const hd = join(d, "hub-data"),
      od = join(d, "old-data"),
      nd = join(d, "new-data");
    assert.equal(
      call(h, [
        "init",
        "--agent",
        "leader",
        "--root",
        hd,
        "--address",
        "127.0.0.1:23456",
        "--service",
        "manual",
      ]).ok,
      true,
    );
    for (const id of ["dev", "research"]) {
      assert.equal(
        call(h, ["invite", "--agent", id, "--out", join(d, id + ".invite")]).ok,
        true,
      );
      assert.equal(
        call(old, [
          "join",
          "--invite",
          join(d, id + ".invite"),
          "--root",
          od,
          "--out",
          join(d, id + ".receipt"),
          "--service",
          "manual",
        ]).ok,
        true,
      );
      assert.equal(
        call(h, ["enroll", "--receipt", join(d, id + ".receipt")]).ok,
        true,
      );
    }
    assert.equal(call(old, ["context"]).error.code, "IDENTITY_REQUIRED");
    assert.equal(
      call(old, ["context"], { KIOKU_AGENT_ID: "research" }).data.agentId,
      "research",
    );
    await writeFile(
      join(od, "agents/dev/raw/original.md"),
      "keep this history\n",
    );
    const bundle = join(d, "bundle");
    assert.equal(
      call(old, [
        "agent",
        "migrate",
        "--agent",
        "dev",
        "--target",
        bundle,
        "--confirm",
        "dev",
      ]).ok,
      true,
    );
    assert.equal(
      call(old, ["context", "--agent", "dev"]).error.code,
      "UNKNOWN_AGENT",
    );
    assert.equal(
      call(h, [
        "agent",
        "migrate",
        "--receipt",
        join(bundle, "migration.json"),
        "--out",
        join(d, "migration.invite"),
        "--confirm",
        "dev",
      ]).ok,
      true,
    );
    assert.equal(
      call(fresh, [
        "join",
        "--invite",
        join(d, "migration.invite"),
        "--root",
        nd,
        "--out",
        join(d, "new.receipt"),
        "--service",
        "manual",
      ]).error.code,
      "MIGRATION_SEED_REQUIRED",
    );
    // Reproduce a restart after a subset of immutable seed files was installed.
    await mkdir(join(nd, "agents/dev/raw"), { recursive: true });
    await writeFile(
      join(nd, "agents/dev/raw/original.md"),
      "keep this history\n",
    );
    assert.equal(
      call(fresh, [
        "join",
        "--invite",
        join(d, "migration.invite"),
        "--root",
        nd,
        "--out",
        join(d, "new.receipt"),
        "--service",
        "manual",
        "--seed",
        bundle,
      ]).ok,
      true,
    );
    assert.equal(
      await readFile(join(nd, "agents/dev/raw/original.md"), "utf8"),
      "keep this history\n",
    );
    assert.equal(
      call(h, ["enroll", "--receipt", join(d, "new.receipt")]).ok,
      true,
    );
    assert.equal(
      call(h, ["enroll", "--receipt", join(d, "dev.receipt")]).error.code,
      "UNKNOWN_INVITATION",
    );
    // Move back to the original node, which still contains retired history.
    await writeFile(join(nd, "agents/dev/raw/later.md"), "new knowledge\n");
    const backBundle = join(d, "back-bundle"),
      backInvite = join(d, "back.invite"),
      backReceipt = join(d, "back.receipt");
    assert.equal(
      call(fresh, [
        "agent",
        "migrate",
        "--agent",
        "dev",
        "--target",
        backBundle,
        "--confirm",
        "dev",
      ]).ok,
      true,
    );
    assert.equal(
      call(h, [
        "agent",
        "migrate",
        "--receipt",
        join(backBundle, "migration.json"),
        "--out",
        backInvite,
        "--confirm",
        "dev",
      ]).ok,
      true,
    );
    assert.equal(
      call(old, [
        "agent",
        "add",
        "--invite",
        join(d, "dev.invite"),
        "--out",
        join(d, "replay.receipt"),
      ]).error.code,
      "AGENT_RETIRED",
    );
    const returned = call(old, [
      "agent",
      "add",
      "--invite",
      backInvite,
      "--seed",
      backBundle,
      "--out",
      backReceipt,
    ]);
    assert.equal(returned.ok, true, JSON.stringify(returned));
    assert.equal(
      await readFile(join(od, "agents/dev/raw/later.md"), "utf8"),
      "new knowledge\n",
    );
    assert.equal(call(h, ["enroll", "--receipt", backReceipt]).ok, true);
    const device = call(old, ["context", "--agent", "dev"]).data.deviceId;
    assert.equal(
      call(h, ["node", "revoke", "--device", device, "--confirm", device]).ok,
      true,
    );
    assert.equal(
      call(h, ["agent", "list"]).data.agents.find((a) => a.id === "dev").active,
      false,
    );
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});
