import { join } from "node:path";
import { homedir } from "node:os";
import { createConnection } from "node:net";
import { readFile, stat } from "node:fs/promises";
import { Config, exists, readJson, rawPath } from "./core.js";
import { syncStatus, api } from "./sync.js";
import { viewStatus } from "./views.js";
import { workerStatus } from "./services.js";
import { checkWorkspaces } from "./workspace.js";
import { findBinary, run } from "./process.js";
export async function lastCuration(c: Config): Promise<unknown> {
  const leader = c.agents.find(
    (a) => a.local && a.active && a.role === "leader",
  );
  if (!leader) return null;
  const p = join(rawPath(c, leader.id), ".kioku-curation", "last-run.json");
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
    for (const name of c.mode === "hub" ? ["kioku-curate"] : []) {
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
  const worker = await workerStatus(home);
  check(
    "background-worker",
    Boolean(
      worker &&
        Date.now() - Date.parse(worker.updatedAt) < 15000 &&
        !worker.error,
    ),
    worker?.error ||
      "Background registration and shared-copy refresh heartbeat.",
  );
  const pending = c.agents.filter(
    (a) =>
      a.local &&
      a.active &&
      (a.registration === "pending" || a.registration === "conflict"),
  );
  check(
    "source-registration",
    pending.length === 0,
    pending.map((a) => `${a.id}: ${a.registration}`).join(", ") ||
      "All local sources registered.",
  );
  if (
    (c.workspaces || []).some(
      (w) => c.agents.find((a) => a.id === w.sourceId)?.role === "member",
    )
  ) {
    const view = await viewStatus(home);
    check(
      "shared-copy",
      Boolean(view.lastSuccess && !view.error),
      view.error || `Last successful refresh: ${view.lastSuccess || "none"}`,
    );
  }
  const workspaces = await checkWorkspaces(home, c);
  for (const w of workspaces.checks)
    check(
      `workspace:${w.raw}`,
      w.ok,
      w.detail || "Workspace links and shared-copy write protection verified.",
    );
  return {
    healthy: checks.every((c) => c.ok),
    checks,
    curation: await lastCuration(c),
    note: "Curation receipts are files, not live Hermes execution status. Hermes schedules and runs its own tasks.",
  };
}
