import { mkdir, writeFile, open, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  Config,
  sha,
  requireThat,
  Failure,
  exists,
  readJson,
  atomicJson,
} from "./core.js";
import { api, online, reconcile } from "./sync.js";
import { run } from "./process.js";
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const exec = promisify(execFile);

async function launchAgentLoaded(target: string): Promise<boolean> {
  try {
    await exec("launchctl", ["print", target]);
    return true;
  } catch (error) {
    // launchctl print returns 113 when the specific service is absent.
    if ((error as { code?: number | string }).code === 113) return false;
    throw error;
  }
}

async function unloadLaunchAgent(target: string): Promise<void> {
  if (!(await launchAgentLoaded(target))) return;
  await run("launchctl", ["bootout", target]);
  // bootout can return while the old job is still SIGTERMed. Re-registering
  // that label before launchd finishes removal fails with bootstrap error 5.
  for (let i = 0; i < 100; i++) {
    if (!(await launchAgentLoaded(target))) return;
    await pause(100);
  }
  throw new Failure("SERVICE_NOT_STOPPED", "LaunchAgent is still unloading.");
}
const label = (home: string) => `kiokunet-${sha(home).slice(0, 12)}`;
const escapeXml = (s: string) =>
  s.replace(
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
const unitArg = (s: string) =>
  '"' +
  s.replace(
    /[%\\"\n\r]/g,
    (c) =>
      ({ "%": "%%", "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r" })[c]!,
  ) +
  '"';
export function serveArgs(c: Config) {
  return [
    "serve",
    "--home",
    c.sync.home,
    "--no-browser",
    "--no-upgrade",
    "--no-restart",
  ];
}
export function serviceFiles(
  c: Config,
  home: string,
  platform = process.platform,
  userHome = homedir(),
): { path: string; content: string }[] {
  const id = label(home);
  const syncArgs = workerArgs(home);
  if (platform === "darwin") {
    const directory = join(userHome, "Library", "LaunchAgents");
    const plist = (suffix: string, args: string[], schedule: string) => ({
      path: join(directory, `${id}.${suffix}.plist`),
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${id}.${suffix}</string><key>ProgramArguments</key><array>${args.map((a) => `<string>${escapeXml(a)}</string>`).join("")}</array>${schedule}<key>Umask</key><integer>18</integer><key>StandardOutPath</key><string>${escapeXml(join(dirname(home), "logs", `${suffix}.log`))}</string><key>StandardErrorPath</key><string>${escapeXml(join(dirname(home), "logs", `${suffix}.log`))}</string></dict></plist>\n`,
    });
    return [
      plist(
        "sync",
        syncArgs,
        "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>",
      ),
    ];
  }
  requireThat(
    platform === "linux",
    "UNSUPPORTED_PLATFORM",
    "Native services support macOS and Linux.",
  );
  const dir = join(userHome, ".config", "systemd", "user");
  return [
    {
      path: join(dir, `${id}.service`),
      content: `[Unit]\nDescription=KiokuNet file synchronization\nAfter=network-online.target\n\n[Service]\nExecStart=${syncArgs.map(unitArg).join(" ")}\nRestart=on-failure\nRestartSec=5\nUMask=0022\n\n[Install]\nWantedBy=default.target\n`,
    },
  ];
}
export async function start(c: Config, home: string): Promise<void> {
  await cleanupLegacyBackup(home);
  await mkdir(join(dirname(home), "logs"), { recursive: true, mode: 0o700 });
  if (c.serviceMode === "native" && process.platform === "linux") {
    const uid = String(process.getuid!());
    let lingering = await run("loginctl", [
      "show-user",
      uid,
      "--property=Linger",
      "--value",
    ]);
    if (lingering.trim() !== "yes") {
      try {
        await run("loginctl", ["enable-linger", uid]);
      } catch {}
      lingering = await run("loginctl", [
        "show-user",
        uid,
        "--property=Linger",
        "--value",
      ]);
    }
    requireThat(
      lingering.trim() === "yes",
      "LINGER_REQUIRED",
      "Configuration was saved. Ask your administrator to run loginctl enable-linger for this user, then retry service start. Native setup is not ready without logout/reboot persistence.",
    );
  }
  // Restart existing daemons too: a process retains the umask it inherited
  // before an upgrade, even when its service file has been rewritten.
  if ((await online(c)) || (await workerStatus(home))) await stop(c, home);
  await reconcile(c);
  if (c.serviceMode === "manual") {
    if ((await online(c)) && (await workerStatus(home))) return;
    const log = await open(join(dirname(home), "logs", "sync.log"), "a", 0o600);
    try {
      const previousMask = process.umask(0o022);
      let child;
      try {
        child = spawn(process.execPath, workerArgs(home).slice(1), {
          detached: true,
          stdio: ["ignore", log.fd, log.fd],
          env: { ...process.env, STNOUPGRADE: "1" },
        });
      } finally {
        process.umask(previousMask);
      }
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
    } finally {
      await log.close();
    }
  } else {
    for (const f of serviceFiles(c, home)) {
      await mkdir(dirname(f.path), { recursive: true });
      await writeFile(f.path, f.content, { mode: 0o600 });
    }
    const id = label(home);
    if (process.platform === "darwin") {
      const domain = `gui/${process.getuid!()}`;
      for (const f of serviceFiles(c, home)) {
        const job = `${id}.sync`;
        // Reload only our own registered job; a missing job is not an error.
        await unloadLaunchAgent(`${domain}/${job}`);
        await run("launchctl", ["bootstrap", domain, f.path]);
      }
    } else {
      await run("systemctl", ["--user", "daemon-reload"]);
      await run("systemctl", ["--user", "enable", "--now", `${id}.service`]);
    }
  }
  for (let i = 0; i < 50; i++) {
    if ((await online(c)) && (await workerStatus(home))) return;
    await pause(200);
  }
  throw new Failure(
    "SERVICE_NOT_READY",
    `Sync did not become ready; inspect ${join(dirname(home), "logs", "sync.log")}. Configuration was saved.`,
    undefined,
    1,
  );
}
export async function stop(c: Config, home: string): Promise<void> {
  await cleanupLegacyBackup(home);
  if (c.serviceMode === "native") {
    const id = label(home);
    if (process.platform === "darwin") {
      for (const suffix of ["sync"]) {
        await unloadLaunchAgent(`gui/${process.getuid!()}/${id}.${suffix}`);
      }
    } else {
      await run("systemctl", ["--user", "stop", `${id}.service`]);
    }
  }
  const worker = await workerStatus(home);
  if (worker)
    await atomicJson(join(home, "worker.stop"), { token: worker.token });
  if (await online(c)) await api(c, "system/shutdown", "POST");
  for (let i = 0; i < 80; i++) {
    if (!(await online(c)) && !(await workerStatus(home))) return;
    await pause(100);
  }
  throw new Failure(
    "SERVICE_NOT_STOPPED",
    "Sync is still running.",
    undefined,
    1,
  );
}

// Called only when explicitly changing from native to manual mode, after stop.
export async function unregister(c: Config, home: string): Promise<void> {
  await cleanupLegacyBackup(home);
  if (process.platform === "linux") {
    const id = label(home);
    await run("systemctl", ["--user", "disable", `${id}.service`]);
  }
  for (const f of serviceFiles(c, home)) await rm(f.path, { force: true });
  if (process.platform === "linux")
    await run("systemctl", ["--user", "daemon-reload"]);
}

// Remove only this configuration's obsolete scheduled jobs. Backup data,
// credentials and old curation history are deliberately left untouched.
export async function cleanupLegacyBackup(home: string): Promise<void> {
  const id = label(home);
  if (process.platform === "darwin") {
    const path = join(
      homedir(),
      "Library",
      "LaunchAgents",
      `${id}.backup.plist`,
    );
    if (!(await exists(path))) return;
    const job = `gui/${process.getuid!()}/${id}.backup`;
    let loaded = false;
    try {
      await run("launchctl", ["print", job]);
      loaded = true;
    } catch {}
    if (loaded) await run("launchctl", ["bootout", job]);
    await rm(path);
  } else if (process.platform === "linux") {
    const dir = join(homedir(), ".config", "systemd", "user");
    let changed = false;
    for (const suffix of ["timer", "service"]) {
      const unit = `${id}-backup.${suffix}`,
        path = join(dir, unit);
      if (!(await exists(path))) continue;
      await run("systemctl", ["--user", "disable", "--now", unit]);
      await rm(path);
      changed = true;
    }
    if (changed) await run("systemctl", ["--user", "daemon-reload"]);
  }
}

function workerArgs(home: string): string[] {
  return [
    process.execPath,
    fileURLToPath(new URL("./worker.js", import.meta.url)),
    home,
  ];
}
export async function workerStatus(home: string): Promise<{
  pid: number;
  token: string;
  updatedAt: string;
  error?: string;
} | null> {
  if (!(await exists(join(home, "worker.json")))) return null;
  try {
    const status = await readJson<{
      pid: number;
      token: string;
      updatedAt: string;
      error?: string;
    }>(join(home, "worker.json"));
    process.kill(status.pid, 0);
    return status;
  } catch {
    return null;
  }
}
