import {
  readdir,
  lstat,
  mkdir,
  copyFile,
  mkdtemp,
  rm,
  link,
} from "node:fs/promises";
import { join, dirname, isAbsolute } from "node:path";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { requireThat, exists } from "./core.js";
export interface FileEntry {
  path: string;
  size: number;
  sha256: string;
}
export async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export function safeRelative(path: string): boolean {
  return (
    Boolean(path) &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((p) => p && p !== "." && p !== "..")
  );
}
export async function inventory(
  root: string,
  relative = "",
): Promise<FileEntry[]> {
  const result: FileEntry[] = [];
  for (const name of (await readdir(join(root, relative))).sort()) {
    if (
      name === ".stfolder" ||
      name === ".stversions" ||
      name === ".stignore" ||
      name.startsWith(".syncthing.") ||
      name.endsWith(".kioku-tmp")
    )
      continue;
    const path = relative ? `${relative}/${name}` : name,
      full = join(root, path),
      s = await lstat(full);
    requireThat(
      !s.isSymbolicLink(),
      "UNSAFE_FILE",
      `Symlinks are not included in migration bundles: ${path}`,
    );
    if (s.isDirectory()) result.push(...(await inventory(root, path)));
    else {
      requireThat(s.isFile(), "UNSAFE_FILE", `Not a regular file: ${path}`);
      result.push({ path, size: s.size, sha256: await fileHash(full) });
    }
  }
  return result;
}
export async function copyVerified(
  source: string,
  target: string,
): Promise<FileEntry[]> {
  const before = await inventory(source);
  await mkdir(target, { recursive: true });
  for (const e of before) {
    await mkdir(dirname(join(target, e.path)), { recursive: true });
    await copyFile(join(source, e.path), join(target, e.path));
  }
  await verifyFiles(target, before);
  const after = await inventory(source);
  requireThat(
    JSON.stringify(before) === JSON.stringify(after),
    "SOURCE_CHANGED",
    "Knowledge changed during migration copy; retry when writes settle.",
  );
  return before;
}
export async function verifyFiles(
  root: string,
  entries: FileEntry[],
): Promise<void> {
  requireThat(
    Array.isArray(entries),
    "INVALID_MANIFEST",
    "Manifest files must be an array.",
  );
  const names = new Set<string>();
  for (const e of entries) {
    requireThat(
      typeof e.path === "string" &&
        safeRelative(e.path) &&
        !names.has(e.path) &&
        /^[a-f0-9]{64}$/.test(e.sha256) &&
        Number.isSafeInteger(e.size) &&
        e.size >= 0,
      "INVALID_MANIFEST",
      "Manifest contains invalid or duplicate file entries.",
    );
    names.add(e.path);
  }
  const actual = await inventory(root);
  const sort = (a: FileEntry, b: FileEntry) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  requireThat(
    JSON.stringify(actual.sort(sort)) ===
      JSON.stringify([...entries].sort(sort)),
    "INTEGRITY_FAILED",
    "Migration files do not match their manifest.",
  );
}

// An interrupted migration can resume only while its destination still matches
// the transferred bundle. Publish missing files without replacing user edits.
export async function seedSpace(
  source: string,
  target: string,
  files: FileEntry[],
) {
  await verifyFiles(source, files);
  const present = (await exists(target)) ? await inventory(target) : [];
  const expected = new Map(files.map((f) => [f.path, f]));
  requireThat(
    present.every((f) => {
      const e = expected.get(f.path);
      return e && e.sha256 === f.sha256 && e.size === f.size;
    }),
    "SEED_TARGET_CONFLICT",
    "Existing Raw differs from the migration bundle; no files were replaced.",
  );
  await mkdir(dirname(target), { recursive: true });
  const stage = await mkdtemp(join(dirname(target), ".kioku-seed-"));
  try {
    await copyVerified(source, stage);
    await verifyFiles(stage, files);
    await mkdir(target, { recursive: true });
    const installed = new Set(present.map((f) => f.path));
    for (const f of files) {
      if (installed.has(f.path)) continue;
      await mkdir(dirname(join(target, f.path)), { recursive: true });
      await link(join(stage, f.path), join(target, f.path));
    }
    await verifyFiles(target, files);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
