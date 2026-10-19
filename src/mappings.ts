import { lstat, realpath, readlink, symlink, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  Config,
  DirectoryMapping,
  requireThat,
  canonical,
  inside,
  spacePath,
  save,
} from "./core.js";
import { checkView, refreshView, viewPath } from "./views.js";

export function mappingTarget(c: Config, home: string, m: DirectoryMapping) {
  if (m.kind === "space") return spacePath(c, m.spaceId!);
  return m.writable ? join(c.root, "shared") : viewPath(home, m.kind);
}
async function present(path: string) {
  try {
    return await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
export async function matchesMapping(
  c: Config,
  home: string,
  m: DirectoryMapping,
) {
  return Boolean(
    (await present(m.path))?.isSymbolicLink() &&
      resolve(dirname(m.path), await readlink(m.path)) ===
        mappingTarget(c, home, m),
  );
}
async function validate(c: Config, home: string, m: DirectoryMapping) {
  if (m.kind === "space") {
    const space = c.spaces.find(
      (s) => s.id === m.spaceId && s.local && s.active,
    );
    requireThat(
      space,
      "SPACE_INACTIVE",
      "The space has no active local writer.",
    );
    requireThat(
      (await lstat(spacePath(c, space.id))).isDirectory(),
      "UNSAFE_FILE",
      "Space must be a real directory.",
    );
  } else {
    requireThat(
      m.kind === "shared" || m.kind === "spaces",
      "INVALID_MAPPING",
      "Unknown mapping kind.",
    );
    requireThat(
      m.kind !== "spaces" || (c.mode === "hub" && !m.writable),
      "HUB_REQUIRED",
      "All-space mappings require a Hub and are read-only copies.",
    );
    requireThat(
      !m.writable || c.mode === "hub",
      "HUB_REQUIRED",
      "Writable Shared mappings require a Hub.",
    );
    if (!m.writable) await checkView(home, m.kind);
  }
}
export async function mapDirectory(
  home: string,
  c: Config,
  input: DirectoryMapping,
) {
  const absolute = resolve(input.path);
  const m = {
    ...input,
    path: join(await realpath(dirname(absolute)), basename(absolute)),
  };
  for (const base of [await canonical(dirname(home)), await canonical(c.root)])
    requireThat(
      !inside(base, m.path) && !inside(m.path, base),
      "OVERLAPPING_PATHS",
      "Mappings must be outside installation and knowledge paths.",
    );
  const existing = (c.mappings || []).find(
    (old) => inside(old.path, m.path) || inside(m.path, old.path),
  );
  requireThat(
    !existing || JSON.stringify(existing) === JSON.stringify(m),
    "MAPPING_CONFLICT",
    "Another directory mapping overlaps this path.",
  );
  requireThat(
    !(await present(m.path)) || (await matchesMapping(c, home, m)),
    "OUTPUT_EXISTS",
    "Mapping path already contains different data.",
  );
  if (m.kind !== "space" && !m.writable) await refreshView(c, home, m.kind);
  await validate(c, home, m);
  let created = false;
  try {
    if (!(await present(m.path))) {
      await symlink(mappingTarget(c, home, m), m.path, "dir");
      created = true;
    }
    requireThat(
      await matchesMapping(c, home, m),
      "MAPPING_CHANGED",
      "Directory mapping changed during creation.",
    );
    if (!existing) {
      c.mappings = [...(c.mappings || []), m];
      await save(home, c);
    }
  } catch (e) {
    if (created && (await matchesMapping(c, home, m))) await unlink(m.path);
    throw e;
  }
  return { ...m, target: mappingTarget(c, home, m) };
}
export async function unmapDirectory(home: string, c: Config, path: string) {
  path = join(await canonical(dirname(resolve(path))), basename(resolve(path)));
  const m = c.mappings?.find((m) => m.path === path);
  if (!m) return { unmapped: false, knowledgePreserved: true };
  requireThat(
    !(await present(path)) || (await matchesMapping(c, home, m)),
    "MAPPING_CHANGED",
    "Mapping was replaced; refusing to remove it.",
  );
  if (await present(path)) await unlink(path);
  c.mappings = c.mappings!.filter((entry) => entry !== m);
  await save(home, c);
  return { unmapped: true, knowledgePreserved: true };
}
export async function checkMappings(home: string, c: Config) {
  const checks = [];
  for (const m of c.mappings || []) {
    try {
      await validate(c, home, m);
      requireThat(
        await matchesMapping(c, home, m),
        "MAPPING_CHANGED",
        "Missing or replaced directory mapping.",
      );
      checks.push({ path: m.path, ok: true });
    } catch (e) {
      checks.push({ path: m.path, ok: false, detail: (e as Error).message });
    }
  }
  return { healthy: checks.every((c) => c.ok), checks };
}
