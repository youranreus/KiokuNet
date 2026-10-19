import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  mkdir,
  rename,
  readFile,
  writeFile,
  rmdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli, ok, port } from "../helpers/node-cli.mjs";
import { removeFixture } from "../helpers/files.mjs";
async function asLegacy(home) {
  const path = join(home, "config/config.json"),
    c = JSON.parse(await readFile(path, "utf8"));
  c.version = 1;
  c.agents = c.spaces.map((s) => ({ ...s, role: "member" }));
  delete c.spaces;
  delete c.mappings;
  for (const a of c.agents) {
    await mkdir(join(c.root, "agents", a.id), { recursive: true });
    await rename(
      join(c.root, "spaces", a.id),
      join(c.root, "agents", a.id, "raw"),
    );
  }
  await rmdir(join(c.root, "spaces"));
  await writeFile(path, JSON.stringify(c));
  return c.networkId;
}
test(
  "upgraded offline spaces retain legacy sync IDs when first registering with an upgraded Hub",
  { timeout: 60000 },
  async (t) => {
    const dir = await realpath(
        await mkdtemp(join(tmpdir(), "kioku-upgraded-network-")),
      ),
      hub = join(dir, "hub"),
      node = join(dir, "node");
    t.after(async () => {
      for (const home of [node, hub]) cli(home, ["service", "stop"]);
      await removeFixture(dir);
    });
    ok(hub, [
      "init",
      "--address",
      `127.0.0.1:${await port()}`,
      "--service",
      "manual",
    ]);
    ok(hub, ["invite", "--out", join(dir, "invite")]);
    ok(node, [
      "join",
      "--invite",
      join(dir, "invite"),
      "--out",
      join(dir, "receipt"),
      "--service",
      "manual",
      "--listen-port",
      String(await port()),
    ]);
    ok(hub, ["enroll", "--receipt", join(dir, "receipt")]);
    ok(node, ["space", "add", "--space", "offline"]);
    await writeFile(
      join(node, "data/spaces/offline/note.md"),
      "before registration and upgrade",
    );
    const network = await asLegacy(hub);
    await asLegacy(node);
    for (const home of [hub, node]) {
      ok(home, ["upgrade", "plan"]);
      ok(home, ["upgrade", "apply", "--confirm", network]);
    }
    ok(hub, ["service", "start"]);
    ok(node, ["service", "start"]);
    for (let i = 0; i < 150; i++) {
      const content = await readFile(
        join(hub, "data/spaces/offline/note.md"),
        "utf8",
      ).catch(() => undefined);
      if (content) {
        assert.equal(content, "before registration and upgrade");
        break;
      }
      if (i === 149) assert.fail("upgraded offline space did not synchronize");
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(
      ok(hub, ["space", "info", "--space", "offline"]).syncFolderId,
      `kioku-${network}-raw-offline`,
    );
    assert.equal(
      ok(node, ["space", "info", "--space", "offline"]).registration,
      "registered",
    );
  },
);
