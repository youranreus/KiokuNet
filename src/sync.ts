import {
  readFile,
  writeFile,
  mkdir,
  open,
  lstat,
  rename,
  rm,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  Config,
  Failure,
  exists,
  requireThat,
  spacePath,
  sha,
  registrationPath,
} from "./core.js";
import { run, dependency } from "./process.js";

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      const port = typeof address === "object" && address ? address.port : 0;
      s.close((e) => (e ? reject(e) : resolve(port)));
    });
  });
}
export function endpoint(address: string): string {
  const u = new URL(address.includes("://") ? address : `tcp://${address}`);
  requireThat(
    u.protocol === "tcp:" &&
      u.hostname &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      (!u.pathname || u.pathname === "/"),
    "INVALID_ADDRESS",
    "Use a fixed TCP host or host:port, without credentials or paths.",
  );
  return `tcp://${u.hostname}:${u.port || "22000"}`;
}
export async function setupSync(
  home: string,
  guiPort?: number,
  listenPort?: number,
): Promise<{ sync: Config["sync"]; deviceId: string }> {
  const binary = await dependency(
    "syncthing",
    home,
    process.env.KIOKU_SYNCTHING,
  );
  const syncHome = join(dirname(home), "state", "syncthing");
  await mkdir(syncHome, { recursive: true, mode: 0o700 });
  await run(binary, ["generate", "--home", syncHome], 30_000);
  const output = await run(binary, ["device-id", "--home", syncHome]);
  const deviceId = output
    .trim()
    .split("\n")
    .find((s) => /^[A-Z2-7]{7}(-[A-Z2-7]{7}){7}$/.test(s));
  requireThat(
    deviceId,
    "INVALID_DEVICE_ID",
    "Syncthing did not return a valid device identity.",
  );
  return {
    deviceId,
    sync: {
      binary,
      home: syncHome,
      apiKey: randomBytes(32).toString("hex"),
      guiPort: guiPort || (await freePort()),
      listenPort: listenPort ?? 22000,
    },
  };
}
export const folderId = (c: Config, space?: string) =>
  (space && c.spaces.find((s) => s.id === space)?.syncFolderId) ||
  `kioku-${c.networkId}-${space ? `space-${space}` : "shared"}`;
interface Folder {
  id: string;
  label: string;
  path: string;
  type: string;
  devices: { deviceID: string }[];
  ignorePerms?: boolean;
  syncOwnership?: boolean;
  syncXattrs?: boolean;
  maxConflicts?: number;
  versioning?: { type: string };
}
export function folders(c: Config): Folder[] {
  const permitted = c.peers.filter((p) => !p.revoked).map((p) => p.deviceId);
  const sharedDevices = c.mode === "hub" ? permitted : [c.hubDeviceId];
  const result: Folder[] = [
    {
      id: folderId(c),
      label: "KiokuNet shared",
      path: join(c.root, "shared"),
      type: c.mode === "hub" ? "sendonly" : "receiveonly",
      devices: [...new Set([c.deviceId, ...sharedDevices])].map((deviceID) => ({
        deviceID,
      })),
    },
  ];
  const nodes = c.mode === "hub" ? permitted : [c.deviceId];
  for (const node of nodes)
    for (const channel of ["requests", "replies"] as const) {
      const sender = channel === "requests" ? node : c.hubDeviceId;
      result.push({
        id: `kioku-${c.networkId}-registration-${node}-${channel}`,
        label: `KiokuNet registration ${channel}`,
        path: registrationPath(c, node, channel),
        type: c.deviceId === sender ? "sendonly" : "receiveonly",
        devices: [node, c.hubDeviceId].map((deviceID) => ({ deviceID })),
      });
    }
  for (const a of c.spaces.filter(
    (a) =>
      a.active &&
      (a.local || c.mode === "hub") &&
      (!a.registration || a.registration === "registered"),
  )) {
    const peer = a.local ? c.hubDeviceId : a.deviceId;
    result.push({
      id: folderId(c, a.id),
      label: `KiokuNet space ${a.id}`,
      path: spacePath(c, a.id),
      type: a.local ? "sendonly" : "receiveonly",
      devices: [...new Set([c.deviceId, peer])].map((deviceID) => ({
        deviceID,
      })),
    });
  }
  return result.map((f) => ({
    ...f,
    ignorePerms: true,
    syncOwnership: false,
    syncXattrs: false,
    maxConflicts: 0,
    versioning: { type: "" },
  }));
}
const xml = (s: string | number) =>
  String(s).replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
export async function api<T = any>(
  c: Config,
  path: string,
  method = "GET",
  data?: unknown,
): Promise<T> {
  const r = await fetch(`http://127.0.0.1:${c.sync.guiPort}/rest/${path}`, {
    method,
    headers: { "X-API-Key": c.sync.apiKey, "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok)
    throw new Failure(
      "SYNC_API",
      `Syncthing API ${path}: ${r.status}`,
      undefined,
      1,
    );
  const body = await r.text();
  return (body ? JSON.parse(body) : undefined) as T;
}
export async function online(c: Config): Promise<boolean> {
  try {
    return (await api(c, "system/status")).myID === c.deviceId;
  } catch {
    return false;
  }
}
export async function reconcile(c: Config): Promise<void> {
  const fs = folders(c);
  for (const f of fs) {
    await mkdir(f.path, { recursive: true });
    requireThat(
      !(await lstat(f.path)).isSymbolicLink(),
      "UNSAFE_FILE",
      `Sync root must be a real directory: ${f.path}`,
    );
    await mkdir(join(f.path, ".stfolder"), { recursive: true });
    requireThat(
      !(await lstat(join(f.path, ".stfolder"))).isSymbolicLink(),
      "UNSAFE_FILE",
      "Sync markers must be real directories.",
    );
    const ignorePath = join(f.path, ".stignore");
    const ignore = await readIgnore(ignorePath);
    // Must precede any existing allow-pattern; incomplete records are never announced.
    const managed = "*.kioku-tmp\n";
    if (!ignore.startsWith(managed)) {
      // Stage outside the writable Raw. Atomic replacement never follows a
      // symlink or writes a hard-linked inode swapped into .stignore meanwhile.
      const temporary = join(dirname(f.path), `.kioku-ignore-${randomUUID()}`);
      try {
        await writeFile(temporary, `${managed}${ignore}`, {
          mode: 0o600,
          flag: "wx",
        });
        await rename(temporary, ignorePath);
      } finally {
        await rm(temporary, { force: true });
      }
    }
  }
  const devices = [
    ...new Set([
      c.deviceId,
      ...c.peers.filter((p) => !p.revoked).map((p) => p.deviceId),
      ...(c.mode === "node" ? [c.hubDeviceId] : []),
    ]),
  ].map((deviceID) => ({
    deviceID,
    name: deviceID === c.deviceId ? "kiokunet-local" : "kiokunet-peer",
    addresses:
      c.mode === "node" && deviceID === c.hubDeviceId
        ? [c.hubAddress]
        : ["dynamic"],
    autoAcceptFolders: false,
    introducer: false,
  }));
  const options = {
    listenAddresses: [`tcp://0.0.0.0:${c.sync.listenPort}`],
    globalAnnounceEnabled: false,
    localAnnounceEnabled: false,
    relaysEnabled: false,
    natEnabled: false,
    urAccepted: -1,
    autoUpgradeIntervalH: 0,
    startBrowser: false,
  };
  if (await online(c)) {
    const config = await api(c, "config");
    const defaults = await api(c, "config/defaults/folder");
    const dd = await api(c, "config/defaults/device");
    config.folders = fs.map((f) => ({
      ...defaults,
      ...f,
      rescanIntervalS: 60,
      fsWatcherEnabled: true,
      fsWatcherDelayS: 1,
    }));
    config.devices = devices.map((d) => ({ ...dd, ...d }));
    config.options = { ...config.options, ...options };
    await api(c, "config", "PUT", config);
    return;
  }
  const path = join(c.sync.home, "config.xml");
  const original = await readFile(path, "utf8");
  const version = /<configuration version="(\d+)"/.exec(original)?.[1];
  requireThat(
    version,
    "SYNC_CONFIG",
    "Missing generated Syncthing configuration.",
  );
  const contents = `<configuration version="${version}">\n${fs.map((f) => `<folder id="${xml(f.id)}" label="${xml(f.label)}" path="${xml(f.path)}" type="${f.type}" rescanIntervalS="60" fsWatcherEnabled="true" fsWatcherDelayS="1" ignorePerms="true"><maxConflicts>0</maxConflicts><versioning type=""/><syncOwnership>false</syncOwnership><syncXattrs>false</syncXattrs>${f.devices.map((d) => `<device id="${d.deviceID}"/>`).join("")}</folder>`).join("\n")}
${devices.map((d) => `<device id="${d.deviceID}" name="${d.name}" introducer="false" autoAcceptFolders="false">${d.addresses.map((a) => `<address>${xml(a)}</address>`).join("")}</device>`).join("\n")}
<gui enabled="true" tls="false"><address>127.0.0.1:${c.sync.guiPort}</address><apikey>${c.sync.apiKey}</apikey></gui>
<options><listenAddress>tcp://0.0.0.0:${c.sync.listenPort}</listenAddress><globalAnnounceEnabled>false</globalAnnounceEnabled><localAnnounceEnabled>false</localAnnounceEnabled><relaysEnabled>false</relaysEnabled><natEnabled>false</natEnabled><urAccepted>-1</urAccepted><autoUpgradeIntervalH>0</autoUpgradeIntervalH><startBrowser>false</startBrowser></options>
</configuration>\n`;
  await writeFile(path, contents, { mode: 0o600 });
}

async function readIgnore(path: string): Promise<string> {
  let file;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const s = await file.stat();
    requireThat(
      s.isFile() && s.nlink === 1,
      "UNSAFE_FILE",
      `Sync control file must be a regular, unlinked file: ${path}`,
    );
    return await file.readFile("utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    if ((e as NodeJS.ErrnoException).code === "ELOOP")
      throw new Failure(
        "UNSAFE_FILE",
        `Sync control file must not be a symlink: ${path}`,
      );
    throw e;
  } finally {
    await file?.close();
  }
}
export async function syncStatus(c: Config) {
  if (!(await online(c)))
    return {
      running: false,
      enrollment: c.mode === "hub" ? "hub" : "unknown",
      folders: [],
    };
  const connections = (await api(c, "system/connections")).connections || {};
  const states = await Promise.all(
    folders(c).map(async (f) => {
      try {
        const s = await api(c, `db/status?folder=${encodeURIComponent(f.id)}`);
        return {
          id: f.id,
          state: s.state,
          needItems: s.needTotalItems,
          localChanges: s.receiveOnlyTotalItems,
          errors: s.pullErrors,
        };
      } catch {
        return { id: f.id, state: "unavailable" };
      }
    }),
  );
  return {
    running: true,
    enrollment:
      c.mode === "hub"
        ? "hub"
        : connections[c.hubDeviceId]?.connected
          ? "connected"
          : "awaiting-connection",
    connections: Object.entries(connections).map(([id, value]) => ({
      deviceId: id,
      connected: Boolean((value as any).connected),
    })),
    folders: states,
  };
}
