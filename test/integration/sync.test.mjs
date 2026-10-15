import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
const cli = resolve("dist/cli.js");
function call(home, args) {
  const env = {
    ...process.env,
    KIOKU_SYNCTHING: process.env.KIOKU_SYNCTHING || resolve(".tools/syncthing"),
  };
  delete env.KIOKU_AGENT_ID;
  return JSON.parse(
    execFileSync(process.execPath, [cli, ...args, "--home", home, "--json"], {
      env,
      encoding: "utf8",
    }),
  ).data;
}
async function port() {
  return new Promise((r) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });
}
async function waitFor(fn) {
  let error;
  for (let n = 0; n < 150; n++) {
    try {
      return await fn();
    } catch (e) {
      error = e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw error;
}
test(
  "real peers upload Raw and distribute shared knowledge while keeping original records",
  { timeout: 60000 },
  async () => {
    const d = await mkdtemp(join(tmpdir(), "kioku-sync-")),
      hub = join(d, "hub"),
      node = join(d, "node");
    const hd = join(d, "hub-data"),
      nd = join(d, "node-data");
    try {
      call(hub, [
        "init",
        "--agent",
        "leader",
        "--root",
        hd,
        "--address",
        `127.0.0.1:${await port()}`,
        "--service",
        "manual",
      ]);
      call(hub, ["invite", "--agent", "dev", "--out", join(d, "invite.json")]);
      call(node, [
        "join",
        "--invite",
        join(d, "invite.json"),
        "--root",
        nd,
        "--out",
        join(d, "receipt.json"),
        "--service",
        "manual",
        "--listen-port",
        String(await port()),
      ]);
      call(hub, ["enroll", "--receipt", join(d, "receipt.json")]);
      call(hub, ["service", "start"]);
      call(node, ["service", "start"]);
      await writeFile(
        join(nd, "agents/dev/raw/note.md"),
        "# confirmed source\n",
      );
      await waitFor(async () =>
        assert.equal(
          await readFile(join(hd, "agents/dev/raw/note.md"), "utf8"),
          "# confirmed source\n",
        ),
      );
      await writeFile(
        join(hd, "shared/projects/decision.md"),
        "# shared conclusion\n",
      );
      await waitFor(async () =>
        assert.equal(
          await readFile(join(nd, "shared/projects/decision.md"), "utf8"),
          "# shared conclusion\n",
        ),
      );
      assert.equal(
        await readFile(join(nd, "agents/dev/raw/note.md"), "utf8"),
        "# confirmed source\n",
      );
      assert.equal(call(node, ["status"]).sync.enrollment, "connected");
    } finally {
      for (const h of [node, hub]) {
        try {
          call(h, ["service", "stop"]);
        } catch {}
      }
      await rm(d, { recursive: true, force: true });
    }
  },
);
