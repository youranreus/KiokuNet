import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  readlink,
  symlink,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planUpgrade, applyUpgrade } from "../dist/upgrade.js";
import { load } from "../dist/core.js";
import { removeFixture } from "./helpers/files.mjs";
async function legacy(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "kioku-upgrade-"))),
    install = join(dir, "install"),
    home = join(install, "config"),
    root = join(install, "data");
  t.after(() => removeFixture(dir));
  const c = {
    version: 1,
    networkId: "network",
    deviceId: "hub",
    hubDeviceId: "hub",
    mode: "hub",
    root,
    hubAddress: "tcp://127.0.0.1:22000",
    publicKey: "",
    peers: [],
    invitations: { old: {} },
    receipts: {},
    serviceMode: "manual",
    agents: [
      {
        id: "notes",
        role: "leader",
        local: true,
        active: true,
        deviceId: "hub",
      },
    ],
    sync: {
      home: join(install, "state/syncthing"),
      guiPort: 9,
      listenPort: 22000,
      apiKey: "unused",
    },
    mcp: {
      enabled: false,
      keys: [
        {
          id: "old-key",
          agentId: "notes",
          role: "leader",
          hash: "private-hash",
        },
      ],
    },
  };
  await mkdir(home, { recursive: true });
  await mkdir(c.sync.home, { recursive: true });
  await writeFile(
    join(c.sync.home, "config.xml"),
    '<configuration version="37"/>',
  );
  await mkdir(join(root, "agents/notes/raw"), { recursive: true });
  await writeFile(join(root, "agents/notes/raw/keep.md"), "important content");
  await mkdir(join(root, "shared"));
  await writeFile(
    join(root, "shared/.kioku-shared.json"),
    JSON.stringify({ networkId: "network" }),
  );
  const project = join(dir, "project");
  await mkdir(project);
  c.workspaces = [
    {
      sourceId: "notes",
      raw: join(project, "notes"),
      shared: join(project, "shared"),
      allRaw: join(project, "all"),
    },
  ];
  await symlink(join(root, "agents/notes/raw"), c.workspaces[0].raw);
  await symlink(join(root, "shared"), c.workspaces[0].shared);
  await symlink(join(root, "agents"), c.workspaces[0].allRaw);
  await mkdir(join(home, "oauth"));
  await writeFile(
    join(home, "oauth/state.json"),
    JSON.stringify({
      grants: [{ id: "old-connection", name: "browser" }],
      tokenKey: "old-secret",
    }),
  );
  await writeFile(join(home, "config.json"), JSON.stringify(c));
  return { dir, home, c, root };
}
test("upgrade preview is read-only; apply preserves knowledge, identity, mappings and sync IDs but invalidates old authorizations", async (t) => {
  const f = await legacy(t),
    before = await readFile(join(f.home, "config.json"), "utf8"),
    files = await readdir(f.home);
  const plan = await planUpgrade(f.home);
  assert.deepEqual(await readdir(f.home), files);
  assert.equal(await readFile(join(f.home, "config.json"), "utf8"), before);
  assert.deepEqual(plan.revokeStaticKeys, ["old-key"]);
  assert.deepEqual(plan.oauthConnections, [
    { id: "old-connection", name: "browser" },
  ]);
  await assert.rejects(() => load(f.home), { code: "UPGRADE_REQUIRED" });
  await assert.rejects(() => applyUpgrade(f.home, "wrong"), {
    code: "CONFIRMATION_REQUIRED",
  });
  await applyUpgrade(f.home, "network");
  const c = await load(f.home);
  assert.equal(c.version, 2);
  assert.equal(c.deviceId, "hub");
  assert.equal(c.agents, undefined);
  assert.equal(c.spaces[0].role, undefined);
  assert.equal(c.spaces[0].syncFolderId, "kioku-network-raw-notes");
  assert.deepEqual(c.mcp.keys, []);
  assert.equal(
    await readFile(join(f.root, "spaces/notes/keep.md"), "utf8"),
    "important content",
  );
  assert.equal(
    await readFile(join(f.dir, "project/notes/keep.md"), "utf8"),
    "important content",
  );
  assert.equal(
    await readFile(join(f.dir, "project/all/notes/keep.md"), "utf8"),
    "important content",
  );
  assert.equal(
    await readlink(join(f.dir, "project/shared")),
    join(f.root, "shared"),
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(f.home, "oauth/state.json"), "utf8")).grants,
    [],
  );
  assert.equal(
    await readFile(join(f.home, "config.v1.backup.json"), "utf8"),
    before,
  );
  assert.equal((await applyUpgrade(f.home, "network")).completed, true);
});
test("an interrupted directory upgrade blocks normal startup and resumes without moving or losing content twice", async (t) => {
  const f = await legacy(t);
  await writeFile(join(f.c.sync.home, "config.xml"), "invalid");
  await assert.rejects(() => applyUpgrade(f.home, "network"), {
    code: "SYNC_CONFIG",
  });
  assert.equal(
    await readFile(join(f.root, "spaces/notes/keep.md"), "utf8"),
    "important content",
  );
  await assert.rejects(() => load(f.home), { code: "UPGRADE_IN_PROGRESS" });
  await writeFile(
    join(f.c.sync.home, "config.xml"),
    '<configuration version="37"/>',
  );
  await applyUpgrade(f.home, "network");
  assert.equal((await load(f.home)).version, 2);
});
test("upgrade refuses preexisting destinations and replaced mappings before moving user data", async (t) => {
  const f = await legacy(t);
  await mkdir(join(f.root, "spaces"));
  await assert.rejects(() => planUpgrade(f.home), { code: "OUTPUT_EXISTS" });
  assert.equal(
    await readFile(join(f.root, "agents/notes/raw/keep.md"), "utf8"),
    "important content",
  );
});

test("normal service stop remains available before an old installation is upgraded", async (t) => {
  const f = await legacy(t);
  const { cli } = await import("./helpers/node-cli.mjs");
  const result = cli(join(f.home, ".."), ["service", "stop"]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(
    JSON.parse(await readFile(join(f.home, "config.json"), "utf8")).version,
    1,
  );
});
