import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  mkdir,
  writeFile,
  readFile,
  chmod,
  rename,
  rm,
  mkdtemp,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { Failure, requireThat, sha, exists } from "./core.js";
const exec = promisify(execFile);
export async function run(
  file: string,
  args: string[],
  timeout = 120_000,
  env = process.env,
): Promise<string> {
  try {
    const r = await exec(file, args, {
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      env,
    });
    return r.stdout;
  } catch (e) {
    const error = e as Error & { stderr?: string };
    throw new Failure(
      "PROCESS_FAILED",
      `${file} failed: ${(error.stderr || error.message).slice(0, 2000)}`,
      undefined,
      1,
    );
  }
}
export async function findBinary(
  name: string,
  home: string,
  override?: string,
): Promise<string | undefined> {
  const paths = override
    ? [resolve(override)]
    : [
        join(home, "bin", name),
        ...(process.env.PATH || "").split(delimiter).map((p) => join(p, name)),
      ];
  for (const path of paths) {
    try {
      await access(path, constants.X_OK);
      return resolve(path);
    } catch {}
  }
  return undefined;
}
const syncHashes: Record<string, string> = {
  "macos-arm64":
    "f86bfa0bdbb5b1b13229a7e5643e898e3c4e017a4fff6dd525994ebaf28ff6e2",
  "macos-amd64":
    "d1464be24a7157440dfb52e2d84939f83caf89c129761945abcdd4956e09ffb1",
  "linux-amd64":
    "524ef4e1df1850b719e2378c8369956f4e5f2ab9a46fdf7f45f2b925012147aa",
  "linux-arm64":
    "f054de02462d5d58bd126908f2f92b63aba74f162a5be85e50e96d656e7db47d",
};
async function download(url: string): Promise<Buffer> {
  const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  requireThat(r.ok, "DOWNLOAD_FAILED", `Download failed (${r.status}): ${url}`);
  return Buffer.from(await r.arrayBuffer());
}
export async function dependency(
  name: "syncthing" | "rclone",
  home: string,
  override?: string,
): Promise<string> {
  const existing = await findBinary(name, home, override);
  if (existing) return existing;
  requireThat(
    !override,
    "DEPENDENCY_MISSING",
    `Executable not found: ${override}`,
  );
  const platform = process.platform === "darwin" ? "macos" : process.platform;
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  requireThat(
    syncHashes[`${platform}-${arch}`],
    "UNSUPPORTED_PLATFORM",
    "Supported: macOS/Linux arm64 and amd64.",
  );
  const temp = await mkdtemp(join(tmpdir(), "kioku-dependency-"));
  try {
    const version = name === "syncthing" ? "2.1.6" : "1.75.2";
    const folder =
      name === "syncthing"
        ? `syncthing-${platform}-${arch}-v${version}`
        : `rclone-v${version}-${platform === "macos" ? "osx" : platform}-${arch}`;
    const extension =
      name === "syncthing" && platform === "linux" ? "tar.gz" : "zip";
    const filename = `${folder}.${extension}`;
    const base =
      name === "syncthing"
        ? `https://github.com/syncthing/syncthing/releases/download/v${version}`
        : `https://downloads.rclone.org/v${version}`;
    const bytes = await download(`${base}/${filename}`);
    let hash = syncHashes[`${platform}-${arch}`];
    if (name === "rclone") {
      const sums = (await download(`${base}/SHA256SUMS`)).toString();
      hash = sums
        .split("\n")
        .map((s) => s.trim().split(/\s+/))
        .find((p) => p[1]?.replace(/^\*/, "") === filename)?.[0];
    }
    requireThat(
      hash && sha(bytes) === hash,
      "CHECKSUM_FAILED",
      `Checksum verification failed for ${filename}.`,
    );
    const archive = join(temp, filename);
    await writeFile(archive, bytes);
    const binary = join(home, "bin", name);
    await mkdir(join(home, "bin"), { recursive: true, mode: 0o700 });
    // Extract exactly the executable to stdout. Never unpack arbitrary archive paths.
    const command = extension === "zip" ? "unzip" : "tar";
    const args =
      extension === "zip"
        ? ["-p", archive, `${folder}/${name}`]
        : ["-xOf", archive, `${folder}/${name}`];
    const result = await exec(command, args, {
      encoding: "buffer",
      maxBuffer: 256 * 1024 * 1024,
    });
    await writeFile(`${binary}.tmp`, result.stdout, { mode: 0o700 });
    await chmod(`${binary}.tmp`, 0o700);
    await rename(`${binary}.tmp`, binary);
    return binary;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
