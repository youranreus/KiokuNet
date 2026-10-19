import { join } from "node:path";
import { createConnection } from "node:net";
import { stat } from "node:fs/promises";
import { Config, exists } from "./core.js";
import { syncStatus, api } from "./sync.js";
import { viewStatus } from "./views.js";
import { workerStatus } from "./services.js";
import { checkMappings } from "./mappings.js";
import { findBinary, run } from "./process.js";
import { mcpStatus } from "./mcp/config.js";
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
export async function diagnose(c: Config, home: string) {
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
  const mcp = await mcpStatus(home, c);
  if (mcp.enabled)
    check(
      "mcp-running",
      mcp.running && !mcp.error,
      mcp.error ||
        `MCP listener ${mcp.host}:${mcp.port}; public endpoint ${mcp.publicUrl || "not configured"}`,
    );
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
  const pending = c.spaces.filter(
    (a) =>
      a.local &&
      a.active &&
      (a.registration === "pending" || a.registration === "conflict"),
  );
  check(
    "space-registration",
    pending.length === 0,
    pending.map((a) => `${a.id}: ${a.registration}`).join(", ") ||
      "All local spaces registered.",
  );
  for (const kind of ["shared", "spaces"] as const) {
    if (c.mappings?.some((m) => m.kind === kind && !m.writable)) {
      const view = await viewStatus(home, kind);
      check(
        `${kind}-copy`,
        Boolean(view.lastSuccess && !view.error),
        view.error || `Last successful refresh: ${view.lastSuccess || "none"}`,
      );
    }
  }
  const mappings = await checkMappings(home, c);
  for (const w of mappings.checks)
    check(
      `mapping:${w.path}`,
      w.ok,
      w.detail ||
        "Directory mappings and shared-copy write protection verified.",
    );
  return {
    healthy: checks.every((c) => c.ok),
    checks,
  };
}
