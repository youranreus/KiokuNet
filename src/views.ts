import {
  mkdir,
  readdir,
  lstat,
  readFile,
  writeFile,
  chmod,
  symlink,
  readlink,
  rename,
  rm,
  open,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  Config,
  requireThat,
  exists,
  readJson,
  atomicJson,
  sha,
} from "./core.js";

export const viewPath = (home: string) =>
  join(dirname(home), "views", "shared");
export interface ViewStatus {
  lastSuccess?: string;
  fingerprint?: string;
  error?: string;
}
export async function viewStatus(home: string): Promise<ViewStatus> {
  const path = join(home, "view.json");
  return (await exists(path)) ? readJson<ViewStatus>(path) : {};
}
const internal = (name: string) =>
  [".stfolder", ".stignore", ".stversions", ".kioku-shared.json"].includes(
    name,
  ) ||
  name.startsWith(".syncthing.") ||
  name.endsWith(".kioku-tmp");
interface Entry {
  path: string;
  hash?: string;
}
async function scan(root: string, prefix = ""): Promise<Entry[]> {
  requireThat(
    (await lstat(join(root, prefix))).isDirectory(),
    "UNSAFE_FILE",
    "Shared knowledge must contain real directories.",
  );
  const result: Entry[] = [];
  for (const name of (await readdir(join(root, prefix))).sort()) {
    if (internal(name)) continue;
    const path = join(prefix, name),
      full = join(root, path),
      s = await lstat(full);
    requireThat(
      s.isFile() || s.isDirectory(),
      "UNSAFE_FILE",
      `Unsupported shared entry: ${path}`,
    );
    if (s.isDirectory()) {
      result.push({ path });
      result.push(...(await scan(root, path)));
    } else {
      const file = await open(
        full,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        requireThat(
          (await file.stat()).isFile(),
          "UNSAFE_FILE",
          `Not a file: ${path}`,
        );
        result.push({ path, hash: sha(await file.readFile()) });
      } finally {
        await file.close();
      }
    }
  }
  return result;
}
export async function removeViewGeneration(path: string): Promise<void> {
  const s = await lstat(path);
  if (s.isDirectory()) {
    await chmod(path, 0o700);
    for (const name of await readdir(path))
      await removeViewGeneration(join(path, name));
  }
  await rm(path, { recursive: true, force: true });
}
export async function checkView(home: string): Promise<void> {
  const target = viewPath(home);
  requireThat(
    await exists(target),
    "VIEW_UNAVAILABLE",
    "No successful shared copy is available yet.",
  );
  async function check(path: string): Promise<void> {
    const s = await lstat(path);
    requireThat(
      (s.isDirectory() || s.isFile()) && !(s.mode & 0o222),
      "VIEW_WRITABLE",
      `Shared copy is writable or unsafe: ${path}`,
    );
    if (s.isDirectory())
      for (const name of await readdir(path)) await check(join(path, name));
  }
  const generation = await readlink(target);
  requireThat(
    /^generation-[a-f0-9-]+$/.test(generation),
    "VIEW_UNAVAILABLE",
    "Shared copy target is not managed by KiokuNet.",
  );
  await check(join(dirname(target), generation));
}
// Caller holds the configuration lock, shared with the background worker.
export async function refreshView(
  c: Config,
  home: string,
): Promise<ViewStatus> {
  const previous = await viewStatus(home),
    source = join(c.root, "shared"),
    target = viewPath(home);
  let stage: string | undefined;
  const link = join(dirname(target), `.publish-${randomUUID()}`);
  try {
    const marker = await readJson<{ networkId: string }>(
      join(source, ".kioku-shared.json"),
    );
    requireThat(
      marker.networkId === c.networkId,
      "VIEW_UNAVAILABLE",
      "Waiting for shared knowledge from the Hub.",
    );
    const entries = await scan(source),
      fingerprint = sha(JSON.stringify(entries));
    if (previous.fingerprint === fingerprint && (await exists(target))) {
      await checkView(home);
      if (!previous.error) return previous;
      const recovered = { lastSuccess: new Date().toISOString(), fingerprint };
      await atomicJson(join(home, "view.json"), recovered);
      return recovered;
    }
    const name = `generation-${randomUUID()}`;
    stage = join(dirname(target), name);
    await mkdir(stage, { recursive: true, mode: 0o700 });
    for (const entry of entries) {
      const dest = join(stage, entry.path);
      if (!entry.hash) await mkdir(dest, { recursive: true });
      else {
        const file = await open(
          join(source, entry.path),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          requireThat(
            (await file.stat()).isFile(),
            "UNSAFE_FILE",
            "Shared file changed type during refresh.",
          );
          const bytes = await file.readFile();
          requireThat(
            sha(bytes) === entry.hash,
            "SOURCE_CHANGED",
            "Shared changed during refresh; retrying later.",
          );
          await writeFile(dest, bytes, { flag: "wx", mode: 0o444 });
        } finally {
          await file.close();
        }
      }
    }
    requireThat(
      sha(JSON.stringify(await scan(source))) === fingerprint,
      "SOURCE_CHANGED",
      "Shared changed during refresh; retrying later.",
    );
    for (const entry of [...entries].reverse())
      if (!entry.hash) await chmod(join(stage, entry.path), 0o555);
    await chmod(stage, 0o555);
    await symlink(name, link, "dir");
    await rename(link, target);
    stage = undefined;
    const status = { lastSuccess: new Date().toISOString(), fingerprint };
    await atomicJson(join(home, "view.json"), status);
    // Retain one preceding generation for readers crossing the publication.
    const generations = (await readdir(dirname(target))).filter(
      (n) => /^generation-[a-f0-9-]+$/.test(n) && n !== name,
    );
    const dated = await Promise.all(
      generations.map(async (n) => ({
        name: n,
        time: (await lstat(join(dirname(target), n))).mtimeMs,
      })),
    );
    dated.sort((a, b) => b.time - a.time);
    for (const old of dated.slice(1))
      await removeViewGeneration(join(dirname(target), old.name));
    return status;
  } catch (e) {
    const failed = { ...previous, error: (e as Error).message };
    await atomicJson(join(home, "view.json"), failed);
    return failed;
  } finally {
    await rm(link, { force: true });
    if (stage) await removeViewGeneration(stage);
  }
}
