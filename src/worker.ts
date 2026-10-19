import { spawn } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  load,
  atomicJson,
  readJson,
  exists,
  withLock,
  Failure,
} from "./core.js";
import { online } from "./sync.js";
import { registerSpaces } from "./registration.js";
import { refreshView } from "./views.js";
import { rm } from "node:fs/promises";
import { McpRuntime } from "./mcp/runtime.js";

const home = process.argv[2]!;
const c = await load(home),
  token = randomUUID();
let stopping = false,
  exited = false,
  code = 0;
const mcp = new McpRuntime(home);
const child = spawn(
  c.sync.binary,
  [
    "serve",
    "--home",
    c.sync.home,
    "--no-browser",
    "--no-upgrade",
    "--no-restart",
  ],
  { stdio: "inherit", env: { ...process.env, STNOUPGRADE: "1" } },
);
const stop = () => {
  stopping = true;
  if (!exited) child.kill("SIGTERM");
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
const finished = new Promise<void>((resolve) => {
  child.once("exit", (exit) => {
    // Unexpected clean exits and signals both need native service recovery.
    code = stopping ? 0 : exit || 1;
    exited = true;
    resolve();
  });
  child.once("error", (error) => {
    console.error(error.message);
    code = 1;
    exited = true;
    resolve();
  });
});
let mcpTask: Promise<void> | undefined;
const updateMcp = async () => {
  try {
    await mcp.reconcile(await load(home));
  } catch {
    console.error(
      "MCP reconciliation failed; inspect MCP state and configuration permissions.",
    );
  }
};
try {
  await updateMcp();
  // Keep MCP configuration/heartbeats independent of potentially slow shared
  // copying and registration, without holding the CLI configuration lock.
  mcpTask = (async () => {
    while (!stopping && !exited) {
      await Promise.race([finished, new Promise((r) => setTimeout(r, 1000))]);
      if (!stopping && !exited) await updateMcp();
    }
  })();
  while (!stopping && !exited) {
    let error: string | undefined;
    try {
      if (
        (await exists(join(home, "worker.stop"))) &&
        (await readJson<{ token: string }>(join(home, "worker.stop"))).token ===
          token
      ) {
        stop();
        break;
      }
      if (await online(c))
        await withLock(
          home,
          async () => {
            const current = await load(home);
            await refreshView(current, home);
            if (current.mappings?.some((m) => m.kind === "spaces"))
              await refreshView(current, home, "spaces");
            await registerSpaces(current, home);
          },
          0,
        );
    } catch (e) {
      if (!(e instanceof Failure && e.code === "LOCKED"))
        error = (e as Error).message;
    }
    await atomicJson(join(home, "worker.json"), {
      pid: process.pid,
      token,
      updatedAt: new Date().toISOString(),
      error,
    });
    await Promise.race([finished, new Promise((r) => setTimeout(r, 1000))]);
  }
} finally {
  stop();
  const timer = setTimeout(() => {
    if (!exited) child.kill("SIGKILL");
  }, 5000);
  await mcpTask;
  await mcp.close();
  await finished;
  clearTimeout(timer);
  await rm(join(home, "worker.json"), { force: true });
}
process.exitCode = code;
