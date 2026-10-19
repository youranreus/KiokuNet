import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createServer } from "node:net";
export function cli(home, args) {
  const r = spawnSync(
    process.execPath,
    [resolve("dist/cli.js"), ...args, "--home", home, "--json"],
    {
      encoding: "utf8",
      timeout: 30000,
      env: { ...process.env, KIOKU_SYNCTHING: resolve(".tools/syncthing") },
    },
  );
  assert.ok(r.stdout, r.stderr || String(r.error));
  return JSON.parse(r.stdout);
}
export function ok(home, args) {
  const r = cli(home, args);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.data;
}
export async function port() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}
