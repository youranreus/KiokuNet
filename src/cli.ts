#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import {
  stateHome,
  load,
  context,
  Failure,
  requireThat,
  withLock,
  exists,
  save,
} from "./core.js";
import { initialize, invite, joinNetwork, enroll } from "./network.js";
import { syncStatus } from "./sync.js";
import { start, stop, unregister, serviceFiles } from "./services.js";
import {
  configureBackup,
  backupRun,
  listBackups,
  listNetworks,
  restore,
} from "./backup.js";
import {
  retire,
  revoke,
  exportMigration,
  acceptMigration,
} from "./lifecycle.js";
import { dependency, run } from "./process.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { diagnose, lastCuration, backupHealth } from "./diagnostics.js";

const help = `KiokuNet 0.1.0 — personal agent memory network

  init --agent ID --root DIR --address HOST[:PORT]
  invite --agent ID --out FILE
  join --invite FILE --root DIR --out RECEIPT
  enroll --receipt FILE
  context [--agent ID]
  agent list
  agent add --invite FILE --out RECEIPT
  agent remove --agent ID --confirm ID
  agent migrate --agent ID --target DIR --confirm ID
  agent migrate --receipt MIGRATION --out INVITE --confirm ID
  node revoke --device DEVICE_ID --confirm DEVICE_ID
  status | doctor
  service start|stop|restart|files
  backup configure --target REMOTE:BUCKET/PREFIX [--config FILE]
  backup credentials (interactive rclone credential setup)
  backup run|networks
  backup list [--network SOURCE_UUID]
  backup restore --snapshot ID --target NEW_DIRECTORY [--network SOURCE_UUID]
  deps install
  skill install --runtime codex|hermes-agent [--source REPOSITORY] [--scope global|project]

Global: --home DIR (or KIOKU_HOME), --json, --help
Setup: --service native|manual (default native), --gui-port PORT, --listen-port PORT
manual configures without registering services; use service start for a temporary daemon.
`;
const strings = [
  "home",
  "agent",
  "root",
  "address",
  "invite",
  "out",
  "receipt",
  "service",
  "gui-port",
  "listen-port",
  "device",
  "confirm",
  "target",
  "config",
  "snapshot",
  "runtime",
  "source",
  "scope",
  "network",
  "seed",
];
let json = process.argv.includes("--json");
try {
  const options: Record<string, { type: "string" | "boolean" }> =
    Object.fromEntries(strings.map((k) => [k, { type: "string" as const }]));
  options.json = { type: "boolean" };
  options.help = { type: "boolean" };
  const parsed = parseArgs({ allowPositionals: true, options });
  const args = parsed.values as Record<string, string | boolean | undefined>;
  const [cmd, sub] = parsed.positionals;
  const home = stateHome(args.home as string | undefined);
  if (args.help || !cmd) {
    console.log(help);
    process.exit(0);
  }
  const value = (name: string) =>
    typeof args[name] === "string" ? (args[name] as string) : undefined;
  const need = async (name: string, prompt: string): Promise<string> => {
    if (value(name)) return value(name)!;
    requireThat(
      process.stdin.isTTY && !json,
      "MISSING_ARGUMENT",
      `Missing --${name}.`,
    );
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      const v = (await rl.question(`${prompt}: `)).trim();
      requireThat(v, "MISSING_ARGUMENT", `Missing --${name}.`);
      return v;
    } finally {
      rl.close();
    }
  };
  const port = (name: string) => {
    const v = value(name);
    if (!v) return undefined;
    const n = Number(v);
    requireThat(
      Number.isInteger(n) && n > 0 && n < 65536,
      "INVALID_PORT",
      "Port must be 1–65535.",
    );
    return n;
  };
  const service = value("service") || "native";
  requireThat(
    service === "native" || service === "manual",
    "USAGE",
    "--service must be native or manual.",
  );
  const readOnly =
    ["context", "status", "doctor"].includes(cmd) ||
    (cmd === "agent" && sub === "list") ||
    (cmd === "service" && sub === "files") ||
    (cmd === "backup" && ["list", "networks"].includes(sub || ""));
  const perform = async (): Promise<unknown> => {
    if (cmd === "init") {
      const c = await initialize(home, {
        agent: await need("agent", "Leader Agent ID"),
        root: await need("root", "Knowledge directory"),
        address: await need("address", "Hub fixed address"),
        service,
        guiPort: port("gui-port"),
        listenPort: port("listen-port"),
      });
      return {
        networkId: c.networkId,
        deviceId: c.deviceId,
        root: c.root,
        serviceMode: c.serviceMode,
      };
    }
    if (cmd === "deps" && sub === "install")
      return {
        syncthing: await dependency(
          "syncthing",
          home,
          process.env.KIOKU_SYNCTHING,
        ),
        rclone: await dependency("rclone", home, process.env.KIOKU_RCLONE),
      };
    if (cmd === "join")
      return joinNetwork(
        home,
        await need("invite", "Invitation file"),
        await need("root", "Knowledge directory"),
        await need("out", "Receipt output file"),
        service,
        port("gui-port"),
        port("listen-port"),
        value("seed"),
      );
    const c = await load(home);
    if (cmd === "context") return context(c, home, value("agent"));
    if (cmd === "invite")
      return invite(
        home,
        c,
        await need("agent", "Target Agent ID"),
        await need("out", "Invitation output file"),
      );
    if (cmd === "enroll")
      return enroll(home, c, await need("receipt", "Receipt file"));
    if (cmd === "agent" && sub === "list") return { agents: c.agents };
    if (cmd === "agent" && sub === "add")
      return joinNetwork(
        home,
        await need("invite", "Invitation file"),
        c.root,
        await need("out", "Receipt output file"),
        c.serviceMode,
        undefined,
        undefined,
        value("seed"),
      );
    const confirm = async (id: string) =>
      requireThat(
        (await need(
          "confirm",
          `This stops access; knowledge is kept. Type ${id} again to confirm`,
        )) === id,
        "CONFIRMATION_REQUIRED",
        `Repeat the affected identity in --confirm ${id}.`,
      );
    if (cmd === "agent" && sub === "remove") {
      const id = await need("agent", "Agent ID");
      await confirm(id);
      return retire(home, c, id);
    }
    if (cmd === "node" && sub === "revoke") {
      const id = await need("device", "Device ID");
      await confirm(id);
      return revoke(home, c, id);
    }
    if (cmd === "agent" && sub === "migrate") {
      if (value("receipt")) {
        const id = await need("confirm", "Agent ID to retire on Hub");
        return acceptMigration(
          home,
          c,
          value("receipt")!,
          await need("out", "New invitation file"),
          id,
        );
      }
      const id = await need("agent", "Agent ID");
      await confirm(id);
      return exportMigration(
        home,
        c,
        id,
        await need("target", "New migration bundle directory"),
      );
    }
    if (cmd === "skill" && sub === "install") {
      const runtime = await need("runtime", "Runtime: codex or hermes-agent");
      requireThat(
        ["codex", "hermes-agent", "pi", "universal"].includes(runtime),
        "UNSUPPORTED_RUNTIME",
        "Supported runtime identifiers: codex, hermes-agent, pi, universal.",
      );
      const scope = value("scope") || "global";
      requireThat(
        ["global", "project"].includes(scope),
        "USAGE",
        "Scope must be global or project.",
      );
      const source =
        value("source") ||
        resolve(dirname(fileURLToPath(import.meta.url)), "..");
      requireThat(
        !source.startsWith("-"),
        "INVALID_SOURCE",
        "Invalid skill source.",
      );
      const names =
        c.mode === "hub" ? ["kioku-memory", "kioku-curate"] : ["kioku-memory"];
      const output = await run("npx", [
        "-y",
        "skills@1.7.2",
        "add",
        source,
        "--skill",
        ...names,
        "-a",
        runtime,
        ...(scope === "global" ? ["-g"] : []),
        "-y",
      ]);
      return {
        runtime,
        scope,
        source,
        skills: names,
        output,
        contextBinding: {
          KIOKU_HOME: home,
          instruction:
            "Bind KIOKU_AGENT_ID or pass --agent when multiple instances exist.",
        },
      };
    }
    if (cmd === "backup") {
      const credentials = async () => {
        requireThat(
          c.mode === "hub",
          "HUB_REQUIRED",
          "Cloud credentials belong on the Hub.",
        );
        requireThat(
          process.stdin.isTTY && !json,
          "INTERACTIVE_REQUIRED",
          "Run backup credentials in a terminal, or supply an existing --config file.",
        );
        const binary = await dependency(
          "rclone",
          home,
          process.env.KIOKU_RCLONE,
        );
        const path = resolve(home, "rclone.conf");
        await new Promise<void>((done, reject) => {
          const child = spawn(binary, ["config", "--config", path], {
            stdio: "inherit",
          });
          child.once("error", reject);
          child.once("exit", (code) =>
            code === 0
              ? done()
              : reject(
                  new Failure(
                    "CONFIG_FAILED",
                    "rclone credential setup did not complete.",
                  ),
                ),
          );
        });
        return path;
      };
      if (sub === "credentials") return { configPath: await credentials() };
      if (sub === "configure") {
        const target = await need(
          "target",
          "rclone target (remote:bucket/prefix or local directory)",
        );
        let configPath = value("config");
        if (!configPath && /^[a-zA-Z][a-zA-Z0-9_-]*:/.test(target)) {
          configPath = resolve(home, "rclone.conf");
          if (!(await exists(configPath))) configPath = await credentials();
        }
        const result = await configureBackup(home, c, target, configPath);
        if (c.serviceMode === "native") await start(c, home);
        return result;
      }
      if (sub === "run") return backupRun(home, c);
      if (sub === "networks") return listNetworks(c);
      if (sub === "list") return listBackups(c, value("network"));
      if (sub === "restore")
        return restore(
          home,
          c,
          await need("snapshot", "Snapshot ID"),
          await need("target", "New restore directory"),
          value("network"),
        );
    }
    if (cmd === "status")
      return {
        networkId: c.networkId,
        mode: c.mode,
        root: c.root,
        agents: c.agents,
        sync: await syncStatus(c),
        backup: backupHealth(c),
        curation: await lastCuration(home),
        serviceMode: c.serviceMode,
      };
    if (cmd === "doctor") {
      const result = await diagnose(c, home, value("runtime"));
      if (!result.healthy) process.exitCode = 3;
      return result;
    }
    if (cmd === "service") {
      if (sub === "files") return { files: serviceFiles(c, home) };
      requireThat(
        ["start", "stop", "restart"].includes(sub || ""),
        "USAGE",
        "service start|stop|restart|files",
      );
      if (value("service") && service !== c.serviceMode) {
        await stop(c, home);
        if (c.serviceMode === "native") await unregister(c, home);
        c.serviceMode = service;
        await save(home, c);
      }
      if (sub !== "start") await stop(c, home);
      if (sub !== "stop") await start(c, home);
      return { service: sub, mode: c.serviceMode };
    }
    throw new Failure("USAGE", help);
  };
  const result = readOnly ? await perform() : await withLock(home, perform);
  console.log(
    JSON.stringify({ ok: true, data: result }, null, json ? undefined : 2),
  );
} catch (error) {
  const e =
    error instanceof Failure
      ? error
      : String((error as NodeJS.ErrnoException).code).startsWith(
            "ERR_PARSE_ARGS",
          )
        ? new Failure("USAGE", (error as Error).message)
        : new Failure("INTERNAL", (error as Error).message, undefined, 1);
  console.log(
    JSON.stringify(
      {
        ok: false,
        error: { code: e.code, message: e.message, details: e.details },
      },
      null,
      json ? undefined : 2,
    ),
  );
  process.exitCode = e.exit;
}
