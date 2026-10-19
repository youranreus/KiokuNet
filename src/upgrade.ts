import {
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  Config,
  DirectoryMapping,
  atomicJson,
  readJson,
  requireThat,
  sha,
  validId,
} from "./core.js";
import { online, reconcile } from "./sync.js";
import { workerStatus } from "./services.js";
import { mappingTarget } from "./mappings.js";
import { refreshView, checkView } from "./views.js";
import { resetOAuth } from "./mcp/oauth-store.js";

interface Move {
  from: string;
  to: string;
  inode: number;
  device: number;
}
interface LinkChange {
  path: string;
  from: string;
  to: string;
}
interface Upgrade {
  version: 1;
  oldHash: string;
  original: any;
  config: Config;
  moves: Move[];
  links: LinkChange[];
  completed?: boolean;
}
const journalPath = (home: string) => join(home, "upgrade-v2.json");
async function stat(path: string) {
  try {
    return await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
async function prepare(home: string): Promise<Upgrade> {
  const text = await readFile(join(home, "config.json"), "utf8"),
    old = JSON.parse(text);
  requireThat(
    old.version === 1 && Array.isArray(old.agents),
    "UPGRADE_NOT_NEEDED",
    "Only version 1 configurations need this upgrade.",
  );
  requireThat(
    resolve(old.root) === join(dirname(resolve(home)), "data"),
    "INVALID_CONFIG",
    "Legacy knowledge root must be <installation>/data.",
  );
  for (const path of [
    dirname(home),
    home,
    old.root,
    join(old.root, "agents"),
  ]) {
    const s = await stat(path);
    requireThat(
      !s || s.isDirectory(),
      "UNSAFE_PATH",
      `Not a real directory: ${path}`,
    );
  }
  const ids = old.agents.map((a: any) => validId(a.id));
  requireThat(
    new Set(ids).size === ids.length,
    "INVALID_CONFIG",
    "Duplicate legacy space identifiers.",
  );
  const config: Config = {
    ...old,
    version: 2,
    oauthRevision: randomUUID(),
    spaces: old.agents.map((a: any) => {
      const { role: _, ...space } = a;
      return {
        ...space,
        authorizationRevision: randomUUID(),
        syncFolderId: `kioku-${old.networkId}-raw-${a.id}`,
      };
    }),
    mappings: [],
    invitations: {},
    receipts: {},
    ...(old.mcp ? { mcp: { ...old.mcp, keys: [] } } : {}),
  };
  delete (config as any).agents;
  delete (config as any).workspaces;
  const result: Upgrade = {
    version: 1,
    oldHash: sha(text),
    original: old,
    config,
    moves: [],
    links: [],
  };
  const spacesRoot = join(old.root, "spaces");
  requireThat(
    !(await stat(spacesRoot)),
    "OUTPUT_EXISTS",
    `New spaces directory already exists: ${spacesRoot}`,
  );
  for (const id of ids) {
    const parent = join(old.root, "agents", id),
      from = join(parent, "raw"),
      to = join(spacesRoot, id);
    const parentStat = await stat(parent),
      source = await stat(from);
    requireThat(
      !parentStat || parentStat.isDirectory(),
      "UNSAFE_PATH",
      `Unsafe legacy directory: ${parent}`,
    );
    requireThat(
      !source || source.isDirectory(),
      "UNSAFE_PATH",
      `Unsafe legacy space: ${from}`,
    );
    if (source)
      result.moves.push({ from, to, inode: source.ino, device: source.dev });
    else
      requireThat(
        !old.agents.find((a: any) => a.id === id).active,
        "NOT_FOUND",
        `Active space directory missing: ${from}`,
      );
  }
  const add = async (m: DirectoryMapping, from: string) => {
    m.path = resolve(m.path);
    requireThat(
      !config.mappings!.some((old) => old.path === m.path),
      "MAPPING_CONFLICT",
      `Duplicate mapping: ${m.path}`,
    );
    const info = await stat(m.path);
    requireThat(
      !info ||
        (info.isSymbolicLink() &&
          resolve(dirname(m.path), await readlink(m.path)) === from),
      "MAPPING_CHANGED",
      `Legacy mapping was replaced: ${m.path}`,
    );
    config.mappings!.push(m);
    result.links.push({
      path: m.path,
      from,
      to: mappingTarget(config, home, m),
    });
  };
  for (const w of old.workspaces || []) {
    const space = old.agents.find((a: any) => a.id === w.sourceId);
    requireThat(
      space,
      "INVALID_CONFIG",
      "Legacy mapping has no registered space.",
    );
    await add(
      { kind: "space", spaceId: space.id, path: w.raw, writable: true },
      join(old.root, "agents", space.id, "raw"),
    );
    await add(
      { kind: "shared", path: w.shared, writable: space.role === "leader" },
      space.role === "leader"
        ? join(old.root, "shared")
        : join(dirname(home), "views", "shared"),
    );
    if (w.allRaw)
      await add(
        { kind: "spaces", path: w.allRaw, writable: false },
        join(old.root, "agents"),
      );
  }
  return result;
}
async function pending(home: string) {
  return (await stat(journalPath(home)))
    ? readJson<Upgrade>(journalPath(home))
    : prepare(home);
}
function summary(u: Upgrade) {
  return {
    networkId: u.config.networkId,
    fromVersion: 1,
    toVersion: 2,
    completed: Boolean(u.completed),
    moves: u.moves.map(({ from, to }) => ({ from, to })),
    mappings: u.links,
    revokeStaticKeys: (u.original.mcp?.keys || [])
      .filter((k: any) => !k.revokedAt)
      .map((k: any) => k.id),
    revokeOAuthConnections: "all",
    expireEnrollmentInvitations: Object.keys(u.original.invitations || {}),
    requirements: [
      "Stop services on every node and stop programs writing knowledge before upgrading.",
      "Upgrade all nodes before restarting synchronization.",
      "Backups and the resumable journal remain in the private config directory.",
      "Old signed invitations and migration bundles must be reissued.",
    ],
  };
}
export async function planUpgrade(home: string) {
  const u = await pending(home);
  let oauth: any;
  try {
    oauth = await readJson(join(home, "oauth", "state.json"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return {
    ...summary(u),
    oauthConnections: (oauth?.grants || [])
      .filter((g: any) => !g.revokedAt)
      .map((g: any) => ({ id: g.id, name: g.name })),
  };
}
async function backup(path: string, contents: string) {
  try {
    await writeFile(path, contents, { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    requireThat(
      (await readFile(path, "utf8")) === contents,
      "BACKUP_CONFLICT",
      `Existing backup differs: ${path}`,
    );
  }
}
export async function applyUpgrade(home: string, confirmation: string) {
  const u = await pending(home);
  requireThat(
    confirmation === u.config.networkId,
    "CONFIRMATION_REQUIRED",
    "Confirm the network ID from upgrade plan.",
  );
  if (u.completed) return summary(u);
  requireThat(
    !(await workerStatus(home)) && !(await online(u.original)),
    "SERVICE_RUNNING",
    "Stop KiokuNet and Syncthing before applying the upgrade.",
  );
  const currentText = await readFile(join(home, "config.json"), "utf8");
  const current = JSON.parse(currentText);
  requireThat(
    sha(currentText) === u.oldHash ||
      JSON.stringify(current) === JSON.stringify(u.config),
    "UPGRADE_CONFLICT",
    "Configuration changed since the upgrade was prepared.",
  );
  if (!(await stat(journalPath(home)))) {
    await backup(join(home, "config.v1.backup.json"), currentText);
    await atomicJson(journalPath(home), u);
  }
  const oauthFile = join(home, "oauth", "state.json"),
    oauthBackup = join(home, "oauth.v1.backup.json");
  if (!(await stat(oauthBackup)) && (await stat(oauthFile)))
    await backup(oauthBackup, await readFile(oauthFile, "utf8"));
  for (const path of [u.config.root, join(u.config.root, "spaces")]) {
    const s = await stat(path);
    requireThat(
      !s || s.isDirectory(),
      "UNSAFE_PATH",
      `Upgrade destination is not a real directory: ${path}`,
    );
  }
  await mkdir(join(u.config.root, "spaces"), { recursive: true });
  for (const move of u.moves) {
    const from = await stat(move.from),
      to = await stat(move.to);
    if (!from) {
      requireThat(
        to?.isDirectory() && to.ino === move.inode && to.dev === move.device,
        "UPGRADE_CONFLICT",
        `Missing or replaced space: ${move.to}`,
      );
      continue;
    }
    requireThat(
      from.isDirectory() &&
        from.ino === move.inode &&
        from.dev === move.device &&
        !to,
      "UPGRADE_CONFLICT",
      `Space changed during upgrade: ${move.from}`,
    );
    await rename(move.from, move.to);
  }
  await reconcile(u.config);
  for (const kind of ["shared", "spaces"] as const) {
    if (u.config.mappings?.some((m) => m.kind === kind && !m.writable)) {
      await refreshView(u.config, home, kind);
      await checkView(home, kind);
    }
  }
  for (const link of u.links) {
    const info = await stat(link.path);
    if (info) {
      requireThat(
        info.isSymbolicLink(),
        "MAPPING_CHANGED",
        `Mapping replaced during upgrade: ${link.path}`,
      );
      const target = resolve(dirname(link.path), await readlink(link.path));
      if (target === link.to) continue;
      requireThat(
        target === link.from,
        "MAPPING_CHANGED",
        `Mapping replaced during upgrade: ${link.path}`,
      );
      await unlink(link.path);
    }
    await symlink(link.to, link.path, "dir");
  }
  await atomicJson(join(home, "config.json"), u.config);
  if (u.config.mode === "hub") await resetOAuth(home, u.config);
  u.completed = true;
  await atomicJson(journalPath(home), u);
  return { ...summary(u), servicesStarted: false };
}
