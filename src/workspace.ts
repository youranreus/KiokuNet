import {
  lstat,
  realpath,
  readdir,
  readlink,
  symlink,
  unlink,
} from "node:fs/promises";
import { Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  Config,
  Workspace,
  Failure,
  requireThat,
  canonical,
  inside,
  rawPath,
  save,
} from "./core.js";
import { run } from "./process.js";

interface Account {
  user: string;
  uid: number;
  groups: number[];
}
interface Mapping {
  source: string;
  target: string;
}
interface AttachOptions {
  source: string;
  raw: string;
  shared: string;
  allRaw?: string;
  user: string;
}

async function account(user: string): Promise<Account> {
  requireThat(
    ["darwin", "linux"].includes(process.platform),
    "UNSUPPORTED_PLATFORM",
    "Workspace permissions support macOS and Linux.",
  );
  requireThat(
    /^[a-zA-Z_][a-zA-Z0-9_-]*\$?$/.test(user),
    "INVALID_USER",
    "Supply an existing OS account name.",
  );
  const uid = Number((await run("/usr/bin/id", ["-u", user])).trim());
  const groups = (await run("/usr/bin/id", ["-G", user]))
    .trim()
    .split(/\s+/)
    .map(Number);
  requireThat(
    Number.isSafeInteger(uid) && uid > 0 && groups.every(Number.isSafeInteger),
    "ISOLATION_REQUIRED",
    "The Agent must use an unprivileged OS account.",
  );
  const names = (await run("/usr/bin/id", ["-Gn", user])).trim().split(/\s+/);
  requireThat(
    !names.some((n) =>
      [
        "root",
        "wheel",
        "sudo",
        "admin",
        "docker",
        "lxd",
        "incus",
        "disk",
      ].includes(n),
    ),
    "ISOLATION_REQUIRED",
    "Use a dedicated account without administrative groups or privilege escalation rights.",
  );
  return { user, uid, groups };
}
function bits(s: Stats, a: Account): number {
  return (
    (s.mode >> (s.uid === a.uid ? 6 : a.groups.includes(s.gid) ? 3 : 0)) & 7
  );
}
async function metadata(path: string): Promise<Stats> {
  const s = await lstat(path);
  requireThat(
    !s.isSymbolicLink() && (s.isDirectory() || s.isFile()),
    "UNSAFE_FILE",
    `Expected a real directory or regular file: ${path}`,
  );
  // Extended ACLs may grant rights not represented by the POSIX mode bits.
  // Fail closed rather than claim isolation from an incomplete ACL evaluator.
  const listing = await run(
    "/bin/ls",
    process.platform === "darwin" ? ["-lde", path] : ["-ld", "--", path],
  );
  requireThat(
    listing[10] !== "+" && !/^\s*\d+: /m.test(listing),
    "UNSUPPORTED_ACL",
    `Extended ACLs require a different isolation backend: ${path}`,
  );
  return s;
}
async function parents(
  path: string,
  a: Account,
  protect: boolean,
): Promise<void> {
  let child = await lstat(path);
  for (let p = dirname(path); ; p = dirname(p)) {
    const s = await metadata(p),
      access = bits(s, a);
    requireThat(
      Boolean(access & 1),
      "PATH_INACCESSIBLE",
      `The OS account cannot traverse ${p}.`,
    );
    if (protect) {
      // A sticky shared temporary directory cannot replace another owner's child.
      const sticky = Boolean(s.mode & 0o1000) && child.uid !== a.uid;
      requireThat(
        s.uid !== a.uid && (!(access & 2) || sticky),
        "UNSAFE_ANCESTOR",
        `The OS account can replace a protected source through ${p}.`,
      );
    }
    if (p === dirname(p)) break;
    child = s;
  }
}
const internal = (name: string) =>
  [".stfolder", ".stignore", ".stversions", ".kioku-curation"].includes(name) ||
  name.startsWith(".syncthing.");

async function tree(
  path: string,
  a: Account,
  writable: boolean,
  readable = true,
): Promise<void> {
  const s = await metadata(path),
    access = bits(s, a);
  if (writable) {
    requireThat(
      (access & (s.isDirectory() ? 7 : 6)) === (s.isDirectory() ? 7 : 6),
      "WRITE_REQUIRED",
      `The OS account needs read/write access: ${path}`,
    );
  } else {
    requireThat(
      s.uid !== a.uid && !(access & 2),
      "READ_ONLY_REQUIRED",
      `The OS account can write or change permissions: ${path}`,
    );
    if (readable)
      requireThat(
        (access & (s.isDirectory() ? 5 : 4)) === (s.isDirectory() ? 5 : 4),
        "READ_REQUIRED",
        `The OS account cannot read ${path}.`,
      );
  }
  if (s.isFile())
    requireThat(
      s.nlink === 1,
      "UNSAFE_FILE",
      `Hard-linked knowledge files are unsupported: ${path}`,
    );
  if (s.isDirectory()) {
    for (const name of await readdir(path)) {
      // Sync metadata is managed by infrastructure. A writer can replace files
      // within its own directory, but does not need to read sync control files.
      if (writable && internal(name)) continue;
      await tree(join(path, name), a, writable, readable && !internal(name));
    }
  }
}
function mappings(c: Config, w: Workspace): Mapping[] {
  return [
    { source: rawPath(c, w.sourceId), target: w.raw },
    { source: join(c.root, "shared"), target: w.shared },
    ...(w.allRaw ? [{ source: join(c.root, "agents"), target: w.allRaw }] : []),
  ];
}
async function targetPath(path: string): Promise<string> {
  const absolute = resolve(path);
  // Preserve the final component: canonicalizing a link would mistake its source
  // for the workspace entry, including when detaching.
  return join(await realpath(dirname(absolute)), basename(absolute));
}
async function present(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
}
async function matches(m: Mapping): Promise<boolean> {
  const s = await present(m.target);
  return Boolean(
    s?.isSymbolicLink() &&
      resolve(dirname(m.target), await readlink(m.target)) === m.source,
  );
}
async function validateAccess(
  home: string,
  c: Config,
  w: Workspace,
  a: Account,
): Promise<void> {
  const source = c.agents.find(
    (s) => s.id === w.sourceId && s.local && s.active,
  );
  requireThat(
    source,
    "SOURCE_INACTIVE",
    "The source directory has no active writer on this node.",
  );
  const h = await canonical(home),
    hs = await metadata(h);
  requireThat(
    hs.uid !== a.uid && bits(hs, a) === 0,
    "ISOLATION_REQUIRED",
    "The Agent must not own or access infrastructure configuration, keys or the sync API token.",
  );
  await parents(h, a, true);
  const own = rawPath(c, source.id);
  // The sync service must be able to replace its control files without
  // following writer-controlled links. Use its real account, even when an
  // administrator is executing this attachment command.
  const service: Account = {
    user: String(hs.uid),
    uid: hs.uid,
    groups: (await run("/usr/bin/id", ["-G", String(hs.uid)]))
      .trim()
      .split(/\s+/)
      .map(Number),
  };
  for (const path of [own, join(c.root, "shared")]) {
    const s = await metadata(path);
    requireThat(
      service.uid === 0 || (bits(s, service) & 7) === 7,
      "SYNC_ACCESS_REQUIRED",
      `The infrastructure account needs directory read/write access for safe sync control-file replacement: ${path}`,
    );
  }
  await parents(own, a, true);
  await tree(own, a, true);
  const shared = join(c.root, "shared");
  await parents(shared, a, true);
  await tree(shared, a, source.role === "leader");
  // Enforce permissions on source paths as well as links. Other local writers
  // cannot become an alternative writable route into this account's shared view.
  for (const other of c.agents.filter(
    (s) => s.id !== source.id && (s.local || c.mode === "hub"),
  )) {
    const path = rawPath(c, other.id);
    if (!(await present(path))) continue;
    await parents(path, a, true);
    // Members may lack read permission on other Raw; Leaders must be able to read.
    await tree(path, a, false, source.role === "leader");
  }
  if (source.role === "leader") {
    requireThat(
      w.allRaw,
      "MISSING_ARGUMENT",
      "Leader workspaces require --all-raw-path.",
    );
    const s = await metadata(join(c.root, "agents"));
    requireThat(
      s.uid !== a.uid && bits(s, a) === 5,
      "READ_ONLY_REQUIRED",
      "The Leader must only read the sources container; its own Raw remains writable.",
    );
  } else
    requireThat(
      !w.allRaw,
      "LEADER_REQUIRED",
      "Only Leader workspaces expose all sources.",
    );
  for (const m of mappings(c, w)) {
    const parent = await metadata(dirname(m.target));
    requireThat(
      (bits(parent, a) & 1) === 1,
      "PATH_INACCESSIBLE",
      `The OS account cannot traverse workspace parent ${dirname(m.target)}.`,
    );
    await parents(dirname(m.target), a, false);
  }
}
export async function attachWorkspace(
  home: string,
  c: Config,
  o: AttachOptions,
) {
  const a = await account(o.user);
  requireThat(
    a.uid !== (await lstat(join(home, "config.json"))).uid,
    "ISOLATION_REQUIRED",
    "The Agent must use a separate OS account from the infrastructure.",
  );
  const source = await realpath(o.source);
  const owner = c.agents.find(
    (s) => s.local && s.active && rawPath(c, s.id) === source,
  );
  requireThat(
    owner,
    "UNKNOWN_SOURCE",
    "--source must name a registered active local Raw directory.",
  );
  const w: Workspace = {
    sourceId: owner.id,
    user: a.user,
    uid: a.uid,
    raw: await targetPath(o.raw),
    shared: await targetPath(o.shared),
    ...(o.allRaw ? { allRaw: await targetPath(o.allRaw) } : {}),
  };
  const links = mappings(c, w);
  for (const [i, m] of links.entries()) {
    for (const base of [
      await canonical(home),
      await canonical(c.root),
      ...links.slice(0, i).map((l) => l.target),
    ])
      requireThat(
        !inside(base, m.target) && !inside(m.target, base),
        "OVERLAPPING_PATHS",
        "Workspace entries, knowledge and configuration paths must not overlap.",
      );
    const s = await present(m.target);
    requireThat(
      !s || (await matches(m)),
      "OUTPUT_EXISTS",
      `Workspace entry already exists with different contents: ${m.target}`,
    );
  }
  const existing = (c.workspaces || []).find((old) =>
    mappings(c, old).some((oldLink) =>
      links.some(
        (m) =>
          inside(oldLink.target, m.target) || inside(m.target, oldLink.target),
      ),
    ),
  );
  requireThat(
    !existing || JSON.stringify(existing) === JSON.stringify(w),
    "WORKSPACE_CONFLICT",
    "An existing workspace registration overlaps this mapping.",
  );
  await validateAccess(home, c, w, a);
  const created: Mapping[] = [];
  try {
    for (const m of links)
      if (await present(m.target)) {
        requireThat(
          await matches(m),
          "OUTPUT_EXISTS",
          `Workspace entry changed during verification: ${m.target}`,
        );
      } else {
        await symlink(m.source, m.target, "dir");
        created.push(m);
      }
    for (const m of links)
      requireThat(
        await matches(m),
        "WORKSPACE_CHANGED",
        `Workspace entry changed while attaching: ${m.target}`,
      );
    if (!existing) {
      c.workspaces = [...(c.workspaces || []), w];
      await save(home, c);
    }
  } catch (e) {
    for (const m of created.reverse())
      if (await matches(m)) await unlink(m.target);
    throw e;
  }
  return {
    ...w,
    role: owner.role,
    permissions: {
      raw: "read-write",
      shared: owner.role === "leader" ? "read-write" : "read-only",
    },
    ...(owner.role === "leader"
      ? { progress: join(w.raw, ".kioku-curation") }
      : {}),
  };
}
export async function detachWorkspace(home: string, c: Config, raw: string) {
  const target = join(
    await canonical(dirname(resolve(raw))),
    basename(resolve(raw)),
  );
  const w = c.workspaces?.find((w) => w.raw === target);
  if (!w) return { detached: false, knowledgePreserved: true };
  const links = mappings(c, w);
  for (const m of links)
    requireThat(
      !(await present(m.target)) || (await matches(m)),
      "WORKSPACE_CHANGED",
      `Entry was replaced; refusing to remove it: ${m.target}`,
    );
  for (const m of links) if (await matches(m)) await unlink(m.target);
  c.workspaces = c.workspaces!.filter((item) => item !== w);
  await save(home, c);
  return { detached: true, knowledgePreserved: true };
}
export async function checkWorkspaces(home: string, c: Config) {
  const checks = [];
  for (const w of c.workspaces || []) {
    try {
      const a = await account(w.user);
      requireThat(
        a.uid === w.uid,
        "ACCOUNT_CHANGED",
        "Workspace account UID changed; detach and reattach.",
      );
      await validateAccess(home, c, w, a);
      for (const m of mappings(c, w))
        requireThat(
          await matches(m),
          "WORKSPACE_CHANGED",
          `Missing or replaced entry: ${m.target}`,
        );
      checks.push({ raw: w.raw, ok: true });
    } catch (e) {
      checks.push({
        raw: w.raw,
        ok: false,
        code: e instanceof Failure ? e.code : "CHECK_FAILED",
        detail: (e as Error).message,
      });
    }
  }
  return { healthy: checks.every((c) => c.ok), checks };
}
