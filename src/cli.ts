#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import {
  stateHome,
  load,
  spaceInfo,
  Failure,
  requireThat,
  withLock,
  save,
  readJson,
  Config,
} from "./core.js";
import {
  initialize,
  invite,
  joinNetwork,
  enroll,
  addSpace,
} from "./network.js";
import { viewStatus } from "./views.js";
import {
  configure,
  createKey,
  listKeys,
  revokeKey,
  mcpStatus,
  McpSettings,
} from "./mcp/config.js";
import { syncStatus } from "./sync.js";
import {
  createApproval,
  listConnections,
  resetOAuth,
  revokeConnection,
} from "./mcp/oauth-store.js";
import {
  start,
  stop,
  unregister,
  serviceFiles,
  workerStatus,
} from "./services.js";
import {
  retire,
  revoke,
  exportMigration,
  acceptMigration,
} from "./lifecycle.js";
import { dependency, run } from "./process.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { diagnose } from "./diagnostics.js";
import { mapDirectory, unmapDirectory, checkMappings } from "./mappings.js";
import { planUpgrade, applyUpgrade } from "./upgrade.js";
import type { AccessPermissions } from "./mcp/config.js";

const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
const help = `KiokuNet ${packageVersion} — knowledge spaces across your machines

  init --address HOST[:PORT]
  invite --out FILE
  join --invite FILE --out RECEIPT
  enroll --receipt FILE
  node list | node revoke --device DEVICE_ID --confirm DEVICE_ID
  space add --space ID
  space list | space info --space ID
  space remove --space ID --confirm ID
  space migrate --space ID --target DIR --confirm ID
  space migrate --receipt MIGRATION --out INVITE --confirm ID
  space map --space ID --path PATH
  space map --all --path PATH (Hub: read-only copy of all spaces)
  shared map --path PATH [--access read|read-write] (default read)
  space unmap --path PATH | shared unmap --path PATH
  space mappings | space check
  status | doctor
  service start|stop|restart|files
  mcp enable [--host IP] [--port PORT] [--public-url https://HOST/mcp]
    [--allowed-origins ORIGIN,ORIGIN] [--max-file-bytes N] [--max-keywords N]
    [--max-results N] [--search-timeout-ms N]
  mcp disable | mcp status
  mcp key create [--read-space ID|*] [--write-space ID] [--shared none|read|read-write]
  mcp key list | mcp key revoke --key ID | mcp key rotate --key ID
  mcp oauth enable|disable
  mcp oauth approve [--read-space ID|*] [--write-space ID] [--shared none|read|read-write]
  mcp oauth list | mcp oauth revoke --connection ID
  mcp oauth reset --confirm oauth
  upgrade plan | upgrade apply --confirm NETWORK_ID
  deps install
  skill install --runtime codex|hermes-agent|pi|universal [--skill kioku|kioku-curate]
    [--repository REPOSITORY] [--scope global|project]

Global: --home INSTALL_DIR (or KIOKU_HOME, default ~/.kiokunet), --json, --help
Data: <home>/data/spaces/<id>, <home>/data/shared; private configuration: <home>/config
Setup: --service native|manual (default native), --gui-port PORT, --listen-port PORT
Repeat --read-space / --write-space to select multiple spaces. Quote '*': includes future spaces.
No access is granted by default. Shared access is independent of space permissions.
Manual service start runs synchronization, space registration and read-only copy refresh.
Skill installation defaults to kioku; kioku-curate is optional and can use local paths or MCP.
`;
const strings = [
  "home",
  "space",
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
  "repository",
  "scope",
  "skill",
  "seed",
  "path",
  "access",
  "shared",
  "host",
  "port",
  "public-url",
  "allowed-origins",
  "max-file-bytes",
  "max-keywords",
  "max-results",
  "search-timeout-ms",
  "key",
  "connection",
];
let json = process.argv.includes("--json");
try {
  const options: Record<
    string,
    { type: "string" | "boolean"; multiple?: boolean }
  > = Object.fromEntries(strings.map((k) => [k, { type: "string" as const }]));
  options.json = { type: "boolean" };
  options.help = { type: "boolean" };
  options.all = { type: "boolean" };
  options["read-space"] = { type: "string", multiple: true };
  options["write-space"] = { type: "string", multiple: true };
  const parsed = parseArgs({ allowPositionals: true, options });
  const args = parsed.values as Record<
    string,
    string | string[] | boolean | undefined
  >;
  const [command, sub, action] = parsed.positionals;
  const cmd = command;
  const home = stateHome(args.home as string | undefined);
  if (args.help || !cmd) {
    console.log(help);
    process.exit(0);
  }
  const value = (name: string) =>
    typeof args[name] === "string" ? (args[name] as string) : undefined;
  const permissions = (): AccessPermissions => {
    const reads = (args["read-space"] || []) as string[];
    requireThat(
      !reads.includes("*") || reads.length === 1,
      "INVALID_PERMISSIONS",
      "Use '*' alone or list specific spaces.",
    );
    const shared = value("shared") || "none";
    requireThat(
      ["none", "read", "read-write"].includes(shared),
      "INVALID_PERMISSIONS",
      "Shared must be none, read or read-write.",
    );
    return {
      readSpaces: reads.includes("*") ? "*" : reads,
      writeSpaces: (args["write-space"] || []) as string[],
      shared: shared as AccessPermissions["shared"],
    };
  };
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
    ["status", "doctor"].includes(cmd) ||
    (cmd === "space" &&
      ["list", "info", "mappings", "check"].includes(sub || "")) ||
    (cmd === "node" && sub === "list") ||
    (cmd === "upgrade" && sub === "plan") ||
    (cmd === "service" && sub === "files") ||
    (cmd === "mcp" &&
      (sub === "status" || (sub === "key" && action === "list")));
  const perform = async (): Promise<unknown> => {
    requireThat(
      [
        "init",
        "invite",
        "join",
        "enroll",
        "node",
        "space",
        "shared",
        "status",
        "doctor",
        "service",
        "mcp",
        "upgrade",
        "deps",
        "skill",
      ].includes(cmd),
      "USAGE",
      help,
    );
    if (cmd === "upgrade") {
      if (sub === "plan") return planUpgrade(home);
      if (sub === "apply")
        return applyUpgrade(
          home,
          await need("confirm", "Network ID from upgrade plan"),
        );
      throw new Failure(
        "USAGE",
        "upgrade plan | upgrade apply --confirm NETWORK_ID",
      );
    }
    if (cmd === "init") {
      const c = await initialize(home, {
        root: value("root") || join(dirname(home), "data"),
        address: await need("address", "Hub fixed address"),
        service,
        guiPort: port("gui-port"),
        listenPort: port("listen-port"),
      });
      return {
        networkId: c.networkId,
        deviceId: c.deviceId,
        root: c.root,
        installation: dirname(home),
        config: home,
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
        value("root") || join(dirname(home), "data"),
        await need("out", "Receipt output file"),
        service,
        port("gui-port"),
        port("listen-port"),
        value("seed"),
      );
    if (cmd === "skill" && sub === "install") {
      const name = value("skill") || "kioku";
      requireThat(
        ["kioku", "kioku-curate"].includes(name),
        "UNSUPPORTED_SKILL",
        "Supported skills: kioku, kioku-curate.",
      );
      const runtime = await need(
        "runtime",
        "Runtime: codex, hermes-agent, pi or universal",
      );
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
        value("repository") ||
        resolve(dirname(fileURLToPath(import.meta.url)), "..");
      requireThat(
        !source.startsWith("-"),
        "INVALID_SOURCE",
        "Invalid skill source.",
      );
      const names = [name];
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
          name === "kioku-curate"
            ? "Supply readable space paths and writable Shared, or a suitably authorized MCP connection."
            : "Use kioku for product concepts and CLI workflows. It does not process knowledge content or require an initialized network.",
      };
    }
    let c: Config;
    try {
      c = await load(home);
    } catch (error) {
      // Stopping an old or interrupted installation must remain possible.
      if (
        cmd !== "service" ||
        sub !== "stop" ||
        !(error instanceof Failure) ||
        !["UPGRADE_REQUIRED", "UPGRADE_IN_PROGRESS"].includes(error.code)
      )
        throw error;
      const legacy = await readJson<Config>(join(home, "config.json"));
      requireThat(
        legacy.sync && ["hub", "node"].includes(legacy.mode),
        "INVALID_CONFIG",
        "Cannot stop an invalid installation.",
      );
      await stop(legacy, home);
      return { service: "stop", mode: legacy.serviceMode };
    }
    if (cmd === "mcp") {
      const waitApplied = async () => {
        for (let i = 0; i < 60; i++) {
          const state = await mcpStatus(home, c);
          if (state.applied) {
            requireThat(
              !state.error && (!state.enabled || state.running),
              "MCP_NOT_READY",
              `MCP configuration saved, but the listener is not ready: ${state.error || "stopped"}. Synchronization remains independent.`,
            );
            return state;
          }
          await new Promise((r) => setTimeout(r, 200));
        }
        throw new Failure(
          "MCP_NOT_READY",
          "MCP configuration saved, but the worker has not applied it. Check mcp status and service logs.",
        );
      };
      if (sub === "status") return mcpStatus(home, c);
      if (sub === "oauth") {
        if (action === "enable" || action === "disable") {
          await configure(home, c, { oauthEnabled: action === "enable" });
          return (await workerStatus(home))
            ? waitApplied()
            : mcpStatus(home, c);
        }
        if (action === "approve") return createApproval(home, permissions());
        if (action === "list")
          return { connections: await listConnections(home) };
        if (action === "revoke")
          return revokeConnection(
            home,
            await need("connection", "Connection ID"),
          );
        if (action === "reset") {
          requireThat(
            value("confirm") === "oauth",
            "CONFIRM_REQUIRED",
            "Pass --confirm oauth to invalidate all OAuth clients and connections.",
          );
          return resetOAuth(home);
        }
      }
      if (sub === "key") {
        if (action === "list") return { keys: listKeys(c) };
        if (action === "create") return createKey(home, c, permissions());
        if (action === "revoke")
          return revokeKey(home, c, await need("key", "Key ID"));
        if (action === "rotate") {
          const id = await need("key", "Key ID"),
            key = listKeys(c).find((k) => k.id === id && !k.revokedAt);
          requireThat(key, "UNKNOWN_KEY", "No active matching key.");
          return createKey(home, c, key.permissions, id);
        }
      }
      if (sub === "enable" || sub === "disable") {
        const patch: Partial<McpSettings> = { enabled: sub === "enable" };
        if (sub === "enable") {
          if (value("host")) patch.host = value("host");
          if (value("port")) patch.port = port("port");
          if (value("public-url") !== undefined)
            patch.publicUrl = value("public-url") || undefined;
          if (value("allowed-origins") !== undefined)
            patch.allowedOrigins = value("allowed-origins")!
              .split(",")
              .filter(Boolean);
          for (const [flag, key] of [
            ["max-file-bytes", "maxFileBytes"],
            ["max-keywords", "maxKeywords"],
            ["max-results", "maxResults"],
            ["search-timeout-ms", "searchTimeoutMs"],
          ] as const)
            if (value(flag) !== undefined) patch[key] = Number(value(flag));
        }
        await configure(home, c, patch);
        if (sub === "enable" && !(await workerStatus(home)))
          await start(c, home);
        if (!(await workerStatus(home))) {
          requireThat(
            sub === "disable",
            "MCP_NOT_READY",
            "MCP configuration saved, but the background worker stopped.",
          );
          return mcpStatus(home, c);
        }
        return waitApplied();
      }
      throw new Failure(
        "USAGE",
        "mcp enable|disable|status, mcp key create|list|revoke|rotate, or mcp oauth enable|disable|approve|list|revoke|reset",
      );
    }
    if ((cmd === "space" || cmd === "shared") && sub === "map") {
      const path = await need("path", "Directory entry path");
      if (cmd === "shared") {
        const access = value("access") || "read";
        requireThat(
          ["read", "read-write"].includes(access),
          "USAGE",
          "Shared mapping access must be read or read-write.",
        );
        return mapDirectory(home, c, {
          kind: "shared",
          path,
          writable: access === "read-write",
        });
      }
      requireThat(
        !(args.all && value("space")),
        "USAGE",
        "Choose --all or --space, not both.",
      );
      return mapDirectory(
        home,
        c,
        args.all
          ? { kind: "spaces", path, writable: false }
          : {
              kind: "space",
              spaceId: await need("space", "Space ID"),
              path,
              writable: true,
            },
      );
    }
    if ((cmd === "space" || cmd === "shared") && sub === "unmap")
      return unmapDirectory(
        home,
        c,
        await need("path", "Directory entry path"),
      );
    if (cmd === "space" && sub === "mappings")
      return { mappings: c.mappings || [] };
    if (cmd === "space" && sub === "check") {
      const result = await checkMappings(home, c);
      if (!result.healthy) process.exitCode = 3;
      return result;
    }
    if (cmd === "space" && sub === "info")
      return spaceInfo(c, await need("space", "Space ID"));
    if (cmd === "invite")
      return invite(
        home,
        c,
        undefined,
        await need("out", "Invitation output file"),
      );
    if (cmd === "enroll")
      return enroll(home, c, await need("receipt", "Receipt file"));
    if (cmd === "node" && sub === "list")
      return {
        nodes: [
          { deviceId: c.deviceId, mode: c.mode, local: true },
          ...c.peers.map((p) => ({
            deviceId: p.deviceId,
            revoked: Boolean(p.revoked),
            local: false,
          })),
        ],
      };
    if (cmd === "space" && sub === "list") return { spaces: c.spaces };
    if (cmd === "space" && sub === "add")
      return addSpace(home, c, await need("space", "Space ID"));
    const confirm = async (id: string) =>
      requireThat(
        (await need(
          "confirm",
          `This stops access; knowledge is kept. Type ${id} again to confirm`,
        )) === id,
        "CONFIRMATION_REQUIRED",
        `Repeat the affected identifier in --confirm ${id}.`,
      );
    if (cmd === "space" && sub === "remove") {
      const id = await need("space", "Space ID");
      await confirm(id);
      return retire(home, c, id);
    }
    if (cmd === "node" && sub === "revoke") {
      const id = await need("device", "Device ID");
      await confirm(id);
      return revoke(home, c, id);
    }
    if (cmd === "space" && sub === "migrate") {
      if (value("receipt")) {
        const id = await need("confirm", "Space ID to retire on Hub");
        return acceptMigration(
          home,
          c,
          value("receipt")!,
          await need("out", "New invitation file"),
          id,
        );
      }
      const id = await need("space", "Space ID");
      await confirm(id);
      return exportMigration(
        home,
        c,
        id,
        await need("target", "New migration bundle directory"),
      );
    }
    if (cmd === "status")
      return {
        networkId: c.networkId,
        mode: c.mode,
        root: c.root,
        spaces: c.spaces,
        mappings: c.mappings || [],
        sync: await syncStatus(c),
        view: await viewStatus(home),
        spaceView: await viewStatus(home, "spaces"),
        worker: await workerStatus(home),
        mcp: await mcpStatus(home, c),
        serviceMode: c.serviceMode,
      };
    if (cmd === "doctor") {
      const result = await diagnose(c, home);
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
