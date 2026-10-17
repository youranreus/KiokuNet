import { removeFixture } from "../helpers/files.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, access } from "node:fs/promises";
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
test(
  "macOS native service starts and stops only its uniquely named launch agent",
  {
    skip:
      process.env.KIOKU_TEST_NATIVE !== "1" || process.platform !== "darwin",
    timeout: 30000,
  },
  async () => {
    const d = await mkdtemp(join(tmpdir(), "kioku-native-")),
      home = join(d, "home");
    let files = [];
    try {
      call(home, [
        "init",
        "--agent",
        "leader",
        "--root",
        join(home, "data"),
        "--address",
        `127.0.0.1:${await port()}`,
        "--service",
        "manual",
      ]);
      files = call(home, ["service", "files"]).files;
      for (const f of files)
        assert.match(
          f.path,
          /\/Library\/LaunchAgents\/kiokunet-[a-f0-9]{12}\.sync\.plist$/,
        );
      // Use the CLI's explicit service mode update to register this isolated node.
      call(home, ["service", "start", "--service", "native"]);
      assert.equal(call(home, ["status"]).sync.running, true);
      call(home, [
        "mcp",
        "enable",
        "--host",
        "127.0.0.1",
        "--port",
        String(await port()),
      ]);
      assert.equal(call(home, ["mcp", "status"]).running, true);
      for (let i = 0; i < 5; i++) {
        call(home, ["service", "restart"]);
        assert.equal(call(home, ["mcp", "status"]).running, true);
      }
      call(home, ["service", "stop", "--service", "manual"]);
      assert.equal(call(home, ["status"]).sync.running, false);
      assert.equal(call(home, ["mcp", "status"]).running, false);
      assert.equal(call(home, ["status"]).serviceMode, "manual");
      for (const f of files)
        await assert.rejects(access(f.path), { code: "ENOENT" });
    } finally {
      try {
        call(home, ["service", "stop"]);
      } catch {}
      for (const f of files) await rm(f.path, { force: true });
      await removeFixture(d);
    }
  },
);
