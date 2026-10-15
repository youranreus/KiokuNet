import { readdir, lstat, mkdir, copyFile, readFile } from "node:fs/promises";
import { join, dirname, isAbsolute } from "node:path";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { requireThat } from "./core.js";
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
      `Symlinks are not included in snapshots: ${path}`,
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
    "Knowledge changed during snapshot creation; retry when writes settle.",
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
    "Snapshot files do not match their manifest.",
  );
}
