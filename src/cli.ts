#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import {
  stateHome,
  load,
  context,
  Failure,
  requireThat,
  withLock,
  save,
} from "./core.js";
import { initialize, invite, joinNetwork, enroll } from "./network.js";
import { syncStatus } from "./sync.js";
import { start, stop, unregister, serviceFiles } from "./services.js";
import {
  retire,
  revoke,
  exportMigration,
  acceptMigration,
} from "./lifecycle.js";
import { dependency, run } from "./process.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { diagnose, lastCuration } from "./diagnostics.js";
import {
  attachWorkspace,
  detachWorkspace,
  checkWorkspaces,
} from "./workspace.js";

const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
const help = `KiokuNet ${packageVersion} — personal agent memory network

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
  workspace attach --source RAW_DIR --raw-path PATH --shared-path PATH --user OS_USER [--all-raw-path PATH]
  workspace detach --raw-path PATH
  workspace list | workspace check
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
  "runtime",
  "source",
  "scope",
  "seed",
  "raw-path",
  "shared-path",
  "all-raw-path",
  "user",
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
    (cmd === "workspace" && ["list", "check"].includes(sub || ""));
  const perform = async (): Promise<unknown> => {
    if (cmd === "workspace" && sub === "attach")
      requireThat(
        value("user"),
        "ISOLATION_REQUIRED",
        "Workspace attachment requires --user: a separate, unprivileged OS account.",
      );
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
    if (cmd === "workspace") {
      if (sub === "attach")
        return attachWorkspace(home, c, {
          source: await need("source", "Local Raw source directory"),
          raw: await need("raw-path", "Workspace path for your files"),
          shared: await need(
            "shared-path",
            "Workspace path for shared knowledge",
          ),
          allRaw: value("all-raw-path"),
          user: value("user")!,
        });
      if (sub === "detach")
        return detachWorkspace(
          home,
          c,
          await need("raw-path", "Workspace Raw entry"),
        );
      if (sub === "list") return { workspaces: c.workspaces || [] };
      if (sub === "check") {
        const result = await checkWorkspaces(home, c);
        if (!result.healthy) process.exitCode = 3;
        return result;
      }
    }
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
      requireThat(
        c.mode === "hub",
        "LEADER_REQUIRED",
        "Only Leader curation uses a Skill. Use workspace attach for file access.",
      );
      const names = ["kioku-curate"];
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
        instruction:
          "Supply the Leader workspace paths to the curation task. No Agent identity binding is required.",
      };
    }
    if (cmd === "status")
      return {
        networkId: c.networkId,
        mode: c.mode,
        root: c.root,
        agents: c.agents,
        workspaces: c.workspaces || [],
        sync: await syncStatus(c),
        curation: await lastCuration(c),
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
