import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  rename,
  stat,
} from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  Config,
  requireThat,
  exists,
  atomicJson,
  save,
  canonical,
  inside,
  readJson,
  sha,
} from "./core.js";
import { copyVerified, verifyFiles, FileEntry } from "./files.js";
import { dependency, run } from "./process.js";
import { hubOnly } from "./network.js";
interface Manifest {
  version: 1;
  id: string;
  networkId: string;
  createdAt: string;
  files: FileEntry[];
}
const snapshotPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/;
const remoteRoot = (c: Config) =>
  `${c.backup!.target.replace(/\/$/, "")}/kiokunet-${c.networkId}/snapshots`;
const rcloneArgs = (c: Config) =>
  c.backup?.configPath ? ["--config", c.backup.configPath] : [];
const transfer = (c: Config, args: string[]) =>
  run(
    c.backup!.rclone,
    [...args, ...rcloneArgs(c), "--retries", "2", "--low-level-retries", "2"],
    30 * 60_000,
  );
export async function configureBackup(
  home: string,
  c: Config,
  target: string,
  configPath?: string,
) {
  hubOnly(c);
  requireThat(
    !/[\r\n\0]/.test(target),
    "INVALID_TARGET",
    "Invalid backup target.",
  );
  if (/^[a-zA-Z][a-zA-Z0-9_-]*:/.test(target)) {
    requireThat(
      !target.split("/").some((p) => p === ".."),
      "INVALID_TARGET",
      "Target may not contain parent traversal.",
    );
  } else {
    target = await canonical(target);
    for (const local of [await canonical(c.root), await canonical(home)])
      requireThat(
        !inside(local, target) && !inside(target, local),
        "OVERLAPPING_PATHS",
        "Backup storage must not overlap live knowledge or private configuration.",
      );
  }
  const binary = await dependency("rclone", home, process.env.KIOKU_RCLONE);
  if (configPath) {
    configPath = await canonical(configPath);
    requireThat(
      await exists(configPath),
      "MISSING_CONFIG",
      "rclone config file does not exist.",
    );
    requireThat(
      !inside(c.root, configPath),
      "UNSAFE_CONFIG",
      "Cloud credentials must not be in the knowledge root.",
    );
  }
  const same =
    c.backup?.target === target && c.backup?.configPath === configPath;
  c.backup = {
    target,
    rclone: binary,
    configPath,
    retentionDays: 30,
    ...(same
      ? {
          lastSuccess: c.backup?.lastSuccess,
          lastRestore: c.backup?.lastRestore,
        }
      : {}),
  };
  await save(home, c);
  return { target, namespace: remoteRoot(c), retentionDays: 30, ready: false };
}
function configured(c: Config) {
  hubOnly(c);
  requireThat(c.backup, "BACKUP_NOT_CONFIGURED", "Run backup configure first.");
}
async function complete(c: Config, id: string) {
  requireThat(
    snapshotPattern.test(id),
    "INVALID_SNAPSHOT",
    "Invalid snapshot ID.",
  );
  const marker = JSON.parse(
    await transfer(c, ["cat", `${remoteRoot(c)}/${id}/complete.json`]),
  ) as { networkId: string; id: string; manifestHash: string };
  requireThat(
    marker.networkId === c.networkId &&
      marker.id === id &&
      /^[a-f0-9]{64}$/.test(marker.manifestHash),
    "INVALID_SNAPSHOT",
    "Invalid completion marker.",
  );
  return marker;
}
export async function listBackups(c: Config) {
  configured(c);
  const output = await transfer(c, ["lsf", remoteRoot(c), "--dirs-only"]);
  const snapshots: { id: string; complete: boolean }[] = [];
  for (const id of output
    .split("\n")
    .map((x) => x.replace(/\/$/, ""))
    .filter((x) => snapshotPattern.test(x))
    .sort()) {
    try {
      await complete(c, id);
      snapshots.push({ id, complete: true });
    } catch {
      snapshots.push({ id, complete: false });
    }
  }
  return { snapshots };
}
export async function backupRun(home: string, c: Config) {
  configured(c);
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  await mkdir(join(home, "snapshots"), { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(home, "snapshots", "stage-"));
  try {
    const files = await copyVerified(c.root, join(stage, "data"));
    const m: Manifest = {
      version: 1,
      id,
      networkId: c.networkId,
      createdAt: new Date().toISOString(),
      files,
    };
    await atomicJson(join(stage, "manifest.json"), m);
    const destination = `${remoteRoot(c)}/${id}`;
    await transfer(c, [
      "copy",
      join(stage, "data"),
      `${destination}/data`,
      "--immutable",
    ]);
    await transfer(c, [
      "copyto",
      join(stage, "manifest.json"),
      `${destination}/manifest.json`,
      "--immutable",
    ]);
    // Read remote data back and verify before publishing the completion marker.
    const checked = join(stage, "checked");
    await mkdir(checked);
    await transfer(c, ["copy", `${destination}/data`, checked]);
    await verifyFiles(checked, files);
    await atomicJson(join(stage, "complete.json"), {
      id,
      networkId: c.networkId,
      manifestHash: sha(await readFile(join(stage, "manifest.json"))),
    });
    await transfer(c, [
      "copyto",
      join(stage, "complete.json"),
      `${destination}/complete.json`,
      "--immutable",
    ]);
    c.backup!.lastSuccess = m.createdAt;
    delete c.backup!.lastError;
    await save(home, c);
    const warnings: string[] = [];
    // The namespace is unique to this network. Only valid, complete snapshots qualify for retention cleanup.
    try {
      for (const old of (await listBackups(c)).snapshots) {
        const date = new Date(
          old.id
            .slice(0, 23)
            .replace(/T(\d\d)-(\d\d)-(\d\d)-(\d\d\d)$/, "T$1:$2:$3.$4") + "Z",
        );
        if (
          old.complete &&
          old.id !== id &&
          date.getTime() < Date.now() - c.backup!.retentionDays * 86400_000
        )
          await transfer(c, ["purge", `${remoteRoot(c)}/${old.id}`]);
      }
    } catch {
      warnings.push("Backup completed, but retention cleanup failed.");
    }
    return { id, files: files.length, completed: true, warnings };
  } catch (e) {
    c.backup!.lastError = (e as Error).message;
    await save(home, c);
    throw e;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
export async function restore(
  home: string,
  c: Config,
  id: string,
  target: string,
) {
  configured(c);
  target = await canonical(target);
  requireThat(
    !(await exists(target)),
    "RESTORE_TARGET_EXISTS",
    "Restore requires a new directory; existing directories are never overwritten.",
  );
  for (const local of [await canonical(c.root), await canonical(home)])
    requireThat(
      !inside(local, target) && !inside(target, local),
      "OVERLAPPING_PATHS",
      "Restore target must be outside knowledge and private configuration.",
    );
  const marker = await complete(c, id);
  const manifestText = await transfer(c, [
    "cat",
    `${remoteRoot(c)}/${id}/manifest.json`,
  ]);
  requireThat(
    sha(manifestText) === marker.manifestHash,
    "INTEGRITY_FAILED",
    "Manifest checksum mismatch.",
  );
  const m = JSON.parse(manifestText) as Manifest;
  requireThat(
    m.version === 1 && m.id === id && m.networkId === c.networkId,
    "INVALID_MANIFEST",
    "Snapshot belongs to a different network.",
  );
  await mkdir(dirname(target), { recursive: true });
  const stage = await mkdtemp(join(dirname(target), ".kioku-restore-"));
  try {
    await transfer(c, ["copy", `${remoteRoot(c)}/${id}/data`, stage]);
    await verifyFiles(stage, m.files);
    requireThat(
      !(await exists(target)),
      "RESTORE_TARGET_EXISTS",
      "Restore destination appeared during download.",
    );
    await rename(stage, target);
    c.backup!.lastRestore = new Date().toISOString();
    await save(home, c);
    return {
      id,
      target,
      verified: true,
      files: m.files.length,
      automaticCutover: false,
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
