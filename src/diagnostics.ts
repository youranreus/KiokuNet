import { join } from "node:path";
import { homedir } from "node:os";
import { createConnection } from "node:net";
import { readFile, stat } from "node:fs/promises";
import { Config, exists, readJson } from "./core.js";
import { syncStatus, api } from "./sync.js";
import { findBinary, run } from "./process.js";
export async function lastCuration(home: string): Promise<unknown> {
  const p = join(home, "curation", "last-run.json");
  if (!(await exists(p))) return null;
  try {
    return await readJson(p);
  } catch {
    return { error: "Invalid last-run.json" };
  }
}
function reachable(address: string): Promise<boolean> {
  const u = new URL(address);
  return new Promise((resolve) => {
    const s = createConnection({
      host: u.hostname.replace(/^\[|\]$/g, ""),
      port: Number(u.port),
    });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(2500, () => finish(false));
    s.once("error", () => finish(false));
    s.once("connect", () => finish(true));
  });
}
export function backupHealth(c: Config) {
  const b = c.backup;
  return {
    configured: Boolean(b),
    lastSuccess: b?.lastSuccess ?? null,
    lastRestore: b?.lastRestore ?? null,
    lastError: b?.lastError ?? null,
    fresh: Boolean(
      b?.lastSuccess && Date.now() - Date.parse(b.lastSuccess) <= 86400_000,
    ),
    verifiedRecovery: Boolean(b?.lastRestore),
    schedulingMode: c.serviceMode,
  };
}
export async function diagnose(c: Config, home: string, runtime?: string) {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const check = (name: string, ok: boolean, detail: string) =>
    checks.push({ name, ok, detail });
  check("knowledge-root", await exists(c.root), c.root);
  check(
    "syncthing-executable",
    Boolean(await findBinary("syncthing", home, c.sync.binary)),
    c.sync.binary,
  );
  const sync = await syncStatus(c);
  check("sync-running", sync.running, `Local API 127.0.0.1:${c.sync.guiPort}`);
  if (sync.running) {
    const cfg = await api(c, "config");
    check(
      "private-management",
      cfg.gui.address.startsWith("127.0.0.1:"),
      "Management API must remain loopback-only.",
    );
    check(
      "fixed-address-network",
      !cfg.options.globalAnnounceEnabled &&
        !cfg.options.localAnnounceEnabled &&
        !cfg.options.relaysEnabled &&
        !cfg.options.natEnabled,
      "Global/local discovery, relays and NAT mapping disabled.",
    );
    check(
      "folder-health",
      sync.folders.every(
        (f: any) =>
          !f.errors &&
          f.state !== "unavailable" &&
          f.state !== "error" &&
          !f.localChanges,
      ),
      "Check folder errors and receive-only local changes.",
    );
  }
  if (c.mode === "node") {
    check("hub-port", await reachable(c.hubAddress), c.hubAddress);
    check(
      "hub-connection",
      sync.enrollment === "connected",
      "A disconnected peer may still be awaiting Hub enrollment.",
    );
  }
  if (c.mode === "hub") {
    const backup = backupHealth(c);
    check("backup-configured", backup.configured, "Run backup configure.");
    check(
      "backup-fresh",
      backup.fresh && !backup.lastError,
      "A verified snapshot must have succeeded within 24 hours.",
    );
    check(
      "recovery-drill",
      backup.verifiedRecovery,
      "Restore a snapshot into a new directory.",
    );
  }
  const privateMode = (await stat(join(home, "config.json"))).mode & 0o077;
  check(
    "private-config",
    privateMode === 0,
    "Configuration should only be readable by its owner.",
  );
  if (runtime) {
    const base =
      runtime === "hermes-agent"
        ? join(process.env.HERMES_HOME || join(homedir(), ".hermes"), "skills")
        : join(homedir(), ".agents", "skills");
    for (const name of c.mode === "hub"
      ? ["kioku-memory", "kioku-curate"]
      : ["kioku-memory"]) {
      const local = join(
        process.cwd(),
        runtime === "hermes-agent" ? ".hermes" : ".agents",
        "skills",
        name,
        "SKILL.md",
      );
      check(
        `skill-${name}`,
        (await exists(join(base, name, "SKILL.md"))) || (await exists(local)),
        "File discovery only; verify actual loading in the runtime.",
      );
    }
  }
  if (process.platform === "linux" && c.serviceMode === "native") {
    try {
      const linger = await run("loginctl", [
        "show-user",
        String(process.getuid!()),
        "--property=Linger",
        "--value",
      ]);
      check(
        "service-after-logout",
        linger.trim() === "yes",
        "For always-on user services: loginctl enable-linger <user>.",
      );
    } catch {
      check(
        "service-after-logout",
        false,
        "Could not verify the Linux user service manager / linger setting.",
      );
    }
  }
  return {
    healthy: checks.every((c) => c.ok),
    checks,
    curation: await lastCuration(home),
    note: "Curation receipts are files, not live Hermes execution status. Hermes schedules and runs its own tasks.",
  };
}
