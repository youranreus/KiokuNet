import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
const cli = resolve("dist/cli.js");
function call(home, args, extraEnv = {}) {
  const env = {
    ...process.env,
    KIOKU_SYNCTHING: process.env.KIOKU_SYNCTHING || resolve(".tools/syncthing"),
    ...extraEnv,
  };
  delete env.KIOKU_AGENT_ID;
  if (extraEnv.KIOKU_AGENT_ID) env.KIOKU_AGENT_ID = extraEnv.KIOKU_AGENT_ID;
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
test("signed invitation and receipt enroll one writer, are replay-safe, and resolve identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kioku-enroll-"));
  const hub = join(dir, "hub"),
    node = join(dir, "node");
  try {
    assert.equal(
      call(hub, [
        "init",
        "--agent",
        "hermes-main",
        "--root",
        join(hub, "data"),
        "--address",
        "127.0.0.1:23001",
        "--service",
        "manual",
      ]).ok,
      true,
    );
    assert.equal(call(hub, ["context"]).data.role, "leader");
    const invite = join(dir, "invite.json"),
      receipt = join(dir, "receipt.json");
    assert.equal(
      call(hub, ["invite", "--agent", "dev", "--out", invite]).ok,
      true,
    );
    assert.equal(
      call(node, [
        "join",
        "--invite",
        invite,
        "--root",
        join(node, "data"),
        "--out",
        receipt,
        "--service",
        "manual",
      ]).ok,
      true,
    );
    assert.equal(call(node, ["context"]).data.agentId, "dev");
    assert.equal(call(hub, ["enroll", "--receipt", receipt]).ok, true);
    assert.equal(call(hub, ["enroll", "--receipt", receipt]).ok, true);
    assert.equal(
      call(hub, ["agent", "list"]).data.agents.filter((a) => a.id === "dev")
        .length,
      1,
    );
    assert.equal(
      call(node, ["context", "--agent", "dev"], { KIOKU_AGENT_ID: "research" })
        .error.code,
      "IDENTITY_CONFLICT",
    );
    const localInvite = join(dir, "local.invite"),
      localReceipt = join(dir, "local.receipt");
    assert.equal(
      call(hub, ["invite", "--agent", "hub-research", "--out", localInvite]).ok,
      true,
    );
    const local = call(hub, [
      "agent",
      "add",
      "--invite",
      localInvite,
      "--out",
      localReceipt,
    ]);
    assert.equal(local.ok, true, JSON.stringify(local));
    assert.equal(local.data.enrollment, "registered");
    assert.equal(
      call(hub, ["context", "--agent", "hub-research"]).data.role,
      "member",
    );
    assert.equal(call(hub, ["context"]).error.code, "IDENTITY_REQUIRED");
    const forged = JSON.parse(await readFile(receipt, "utf8"));
    forged.payload.deviceId = "A".repeat(56);
    await writeFile(join(dir, "forged.json"), JSON.stringify(forged));
    assert.equal(
      call(hub, ["enroll", "--receipt", join(dir, "forged.json")]).error.code,
      "INVALID_SIGNATURE",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
