import { mkdir, writeFile, open, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { Config, sha, requireThat, Failure, exists } from "./core.js";
import { api, online, reconcile } from "./sync.js";
import { run } from "./process.js";
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
  const syncArgs = [c.sync.binary, ...serveArgs(c)];
  if (platform === "darwin") {
    const directory = join(userHome, "Library", "LaunchAgents");
    const plist = (suffix: string, args: string[], schedule: string) => ({
      path: join(directory, `${id}.${suffix}.plist`),
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${id}.${suffix}</string><key>ProgramArguments</key><array>${args.map((a) => `<string>${escapeXml(a)}</string>`).join("")}</array>${schedule}<key>Umask</key><integer>18</integer><key>StandardOutPath</key><string>${escapeXml(join(home, `${suffix}.log`))}</string><key>StandardErrorPath</key><string>${escapeXml(join(home, `${suffix}.log`))}</string></dict></plist>\n`,
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
  if (await online(c)) await stop(c, home);
  await reconcile(c);
  if (c.serviceMode === "manual") {
    if (await online(c)) return;
    const log = await open(join(home, "sync.log"), "a", 0o600);
    try {
      const previousMask = process.umask(0o022);
      let child;
      try {
        child = spawn(c.sync.binary, serveArgs(c), {
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
        try {
          await run("launchctl", ["bootout", `${domain}/${job}`]);
        } catch {}
        await run("launchctl", ["bootstrap", domain, f.path]);
      }
    } else {
      await run("systemctl", ["--user", "daemon-reload"]);
      await run("systemctl", ["--user", "enable", "--now", `${id}.service`]);
    }
  }
  for (let i = 0; i < 50; i++) {
    if (await online(c)) return;
    await pause(200);
  }
  throw new Failure(
    "SERVICE_NOT_READY",
    `Sync did not become ready; inspect ${join(home, "sync.log")}. Configuration was saved.`,
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
        try {
          await run("launchctl", [
            "bootout",
            `gui/${process.getuid!()}/${id}.${suffix}`,
          ]);
        } catch {}
      }
    } else {
      await run("systemctl", ["--user", "stop", `${id}.service`]);
    }
  }
  if (await online(c)) await api(c, "system/shutdown", "POST");
  for (let i = 0; i < 30; i++) {
    if (!(await online(c))) return;
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
