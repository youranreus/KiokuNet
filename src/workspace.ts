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
import { checkView, refreshView, viewPath } from "./views.js";

interface Mapping {
  source: string;
  target: string;
}
interface AttachOptions {
  source: string;
  raw: string;
  shared: string;
  allRaw?: string;
}

function mappings(c: Config, w: Workspace, home: string): Mapping[] {
  return [
    { source: rawPath(c, w.sourceId), target: w.raw },
    {
      source:
        c.agents.find((a) => a.id === w.sourceId)?.role === "leader"
          ? join(c.root, "shared")
          : viewPath(home),
      target: w.shared,
    },
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
): Promise<void> {
  const source = c.agents.find(
    (s) => s.id === w.sourceId && s.local && s.active,
  );
  requireThat(
    source,
    "SOURCE_INACTIVE",
    "The source has no active local writer.",
  );
  requireThat(
    !w.allRaw || source.role === "leader",
    "LEADER_REQUIRED",
    "Only Leader workspaces expose all Raw.",
  );
  if (source.role === "leader")
    requireThat(
      c.mode === "hub",
      "HUB_REQUIRED",
      "Leader must run on the Hub.",
    );
  else await checkView(home);
  requireThat(
    (await lstat(rawPath(c, source.id))).isDirectory(),
    "UNSAFE_FILE",
    "Raw must be a real directory.",
  );
}
export async function attachWorkspace(
  home: string,
  c: Config,
  o: AttachOptions,
) {
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
    raw: await targetPath(o.raw),
    shared: await targetPath(o.shared),
    ...(o.allRaw ? { allRaw: await targetPath(o.allRaw) } : {}),
  };
  const links = mappings(c, w, home);
  for (const [i, m] of links.entries()) {
    for (const base of [
      await canonical(dirname(home)),
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
    mappings(c, old, home).some((oldLink) =>
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
  if (owner.role !== "leader") await refreshView(c, home);
  await validateAccess(home, c, w);
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
  const links = mappings(c, w, home);
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
      await validateAccess(home, c, w);
      for (const m of mappings(c, w, home))
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
