import { mkdir, writeFile, open, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
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
  const id = label(home),
    cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  const syncArgs = [c.sync.binary, ...serveArgs(c)];
  const backupArgs = [
    process.execPath,
    cli,
    "backup",
    "run",
    "--home",
    home,
    "--json",
  ];
  if (platform === "darwin") {
    const directory = join(userHome, "Library", "LaunchAgents");
    const plist = (suffix: string, args: string[], schedule: string) => ({
      path: join(directory, `${id}.${suffix}.plist`),
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${id}.${suffix}</string><key>ProgramArguments</key><array>${args.map((a) => `<string>${escapeXml(a)}</string>`).join("")}</array>${schedule}<key>StandardOutPath</key><string>${escapeXml(join(home, `${suffix}.log`))}</string><key>StandardErrorPath</key><string>${escapeXml(join(home, `${suffix}.log`))}</string></dict></plist>\n`,
    });
    return [
      plist(
        "sync",
        syncArgs,
        "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>",
      ),
      ...(c.backup
        ? [
            plist(
              "backup",
              backupArgs,
              "<key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>",
            ),
          ]
        : []),
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
      content: `[Unit]\nDescription=KiokuNet file synchronization\nAfter=network-online.target\n\n[Service]\nExecStart=${syncArgs.map(unitArg).join(" ")}\nRestart=on-failure\nRestartSec=5\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`,
    },
    ...(c.backup
      ? [
          {
            path: join(dir, `${id}-backup.service`),
            content: `[Unit]\nDescription=KiokuNet daily backup\n\n[Service]\nType=oneshot\nExecStart=${backupArgs.map(unitArg).join(" ")}\nUMask=0077\n`,
          },
          {
            path: join(dir, `${id}-backup.timer`),
            content: `[Unit]\nDescription=KiokuNet daily backup timer\n\n[Timer]\nOnCalendar=daily\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`,
          },
        ]
      : []),
  ];
}
export async function start(c: Config, home: string): Promise<void> {
  await reconcile(c);
  if (c.serviceMode === "manual") {
    if (await online(c)) return;
    const log = await open(join(home, "sync.log"), "a", 0o600);
    try {
      const child = spawn(c.sync.binary, serveArgs(c), {
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
        env: { ...process.env, STNOUPGRADE: "1" },
      });
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
        const job = f.path.endsWith(".sync.plist")
          ? `${id}.sync`
          : `${id}.backup`;
        // Reload only our own registered job; a missing job is not an error.
        try {
          await run("launchctl", ["bootout", `${domain}/${job}`]);
        } catch {}
        await run("launchctl", ["bootstrap", domain, f.path]);
      }
    } else {
      await run("systemctl", ["--user", "daemon-reload"]);
      await run("systemctl", ["--user", "enable", "--now", `${id}.service`]);
      if (c.backup)
        await run("systemctl", [
          "--user",
          "enable",
          "--now",
          `${id}-backup.timer`,
        ]);
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
  if (c.serviceMode === "native") {
    const id = label(home);
    if (process.platform === "darwin") {
      for (const suffix of ["sync", "backup"]) {
        try {
          await run("launchctl", [
            "bootout",
            `gui/${process.getuid!()}/${id}.${suffix}`,
          ]);
        } catch {}
      }
    } else {
      await run("systemctl", ["--user", "stop", `${id}.service`]);
      if (c.backup)
        await run("systemctl", ["--user", "stop", `${id}-backup.timer`]);
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
