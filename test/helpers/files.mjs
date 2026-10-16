import { chmod, lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
// Only used on disposable test roots, never on actual installations.
export async function removeFixture(path) {
  let s;
  try {
    s = await lstat(path);
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  if (s.isDirectory()) {
    await chmod(path, 0o700);
    for (const name of await readdir(path))
      await removeFixture(join(path, name));
  }
  await rm(path, { recursive: true, force: true });
}
