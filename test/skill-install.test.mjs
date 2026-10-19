import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  access,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, delimiter } from "node:path";
import { spawnSync } from "node:child_process";

const cli = resolve("dist/cli.js");

async function fixture(t, mode) {
  const dir = await mkdtemp(join(tmpdir(), "kioku-skill-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, "installation");
  const config = join(home, "config", "config.json");
  if (mode) {
    await mkdir(join(home, "config"), { recursive: true });
    await writeFile(config, JSON.stringify({ version: 2, spaces: [], mode }));
  }
  const bin = join(dir, "bin");
  await mkdir(bin);
  const calls = join(dir, "installer-calls.jsonl");
  await writeFile(
    join(bin, "npx"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.KIOKU_TEST_INSTALL_CALLS, JSON.stringify({args, cwd: process.cwd()}) + "\\n");
if (process.env.KIOKU_TEST_INSTALL_FAIL === "1") {
  console.error("installer unavailable");
  process.exit(1);
}
console.log("installed");
`,
    { mode: 0o755 },
  );
  return {
    dir,
    config,
    calls,
    call(args = [], extraEnv = {}) {
      const result = spawnSync(
        process.execPath,
        [cli, "skill", "install", ...args, "--home", home, "--json"],
        {
          cwd: dir,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}${delimiter}${process.env.PATH || ""}`,
            KIOKU_TEST_INSTALL_CALLS: calls,
            ...extraEnv,
          },
        },
      );
      assert.ifError(result.error);
      return { status: result.status, ...JSON.parse(result.stdout) };
    },
  };
}

for (const mode of [undefined, "node", "hub"]) {
  test(`default guide installs on ${mode || "uninitialized machine"} without changing network configuration`, async (t) => {
    const f = await fixture(t, mode);
    const before = mode ? await readFile(f.config, "utf8") : undefined;
    const result = f.call(["--runtime", "codex"]);
    assert.equal(result.status, 0, JSON.stringify(result));
    assert.deepEqual(result.data.skills, ["kioku"]);
    const { args, cwd } = JSON.parse((await readFile(f.calls, "utf8")).trim());
    assert.deepEqual(args, [
      "-y",
      "skills@1.7.2",
      "add",
      resolve("."),
      "--skill",
      "kioku",
      "-a",
      "codex",
      "-g",
      "-y",
    ]);
    assert.equal(cwd, await realpath(f.dir));
    if (mode) assert.equal(await readFile(f.config, "utf8"), before);
    else await assert.rejects(access(f.config), { code: "ENOENT" });
  });
}

test("explicit guide supports each runtime and forwards project scope and source as separate arguments", async (t) => {
  const f = await fixture(t);
  const source = join(f.dir, "source with spaces");
  for (const runtime of ["codex", "hermes-agent", "pi", "universal"]) {
    const result = f.call([
      "--runtime",
      runtime,
      "--skill",
      "kioku",
      "--scope",
      "project",
      "--repository",
      source,
    ]);
    assert.equal(result.status, 0, JSON.stringify(result));
    assert.equal(result.data.scope, "project");
    assert.equal(result.data.source, source);
  }
  const calls = (await readFile(f.calls, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    calls.map(({ args }) => args[args.indexOf("-a") + 1]),
    ["codex", "hermes-agent", "pi", "universal"],
  );
  for (const { args } of calls) {
    assert.equal(args[3], source);
    assert.ok(!args.includes("-g"));
  }
});

test("curation remains optional and can be installed without a local Hub", async (t) => {
  for (const [mode, code] of [
    [undefined, undefined],
    ["node", undefined],
    ["hub", undefined],
  ]) {
    const f = await fixture(t, mode);
    const result = f.call([
      "--runtime",
      "hermes-agent",
      "--skill",
      "kioku-curate",
    ]);
    if (code) {
      assert.equal(result.status, 2);
      assert.equal(result.error.code, code);
      await assert.rejects(access(f.calls), { code: "ENOENT" });
    } else {
      assert.equal(result.status, 0, JSON.stringify(result));
      assert.deepEqual(result.data.skills, ["kioku-curate"]);
      const { args } = JSON.parse((await readFile(f.calls, "utf8")).trim());
      assert.equal(args[args.indexOf("--skill") + 1], "kioku-curate");
    }
  }
});

test("invalid install options fail before invoking the installer", async (t) => {
  const f = await fixture(t);
  for (const [args, code] of [
    [[], "MISSING_ARGUMENT"],
    [["--runtime", "unknown"], "UNSUPPORTED_RUNTIME"],
    [["--runtime", "codex", "--skill", "unknown"], "UNSUPPORTED_SKILL"],
    [["--runtime", "codex", "--scope", "unknown"], "USAGE"],
    [["--runtime", "codex", "--repository=-unsafe"], "INVALID_SOURCE"],
  ]) {
    const result = f.call(args);
    assert.equal(result.status, 2);
    assert.equal(result.error.code, code);
  }
  await assert.rejects(access(f.calls), { code: "ENOENT" });
});

test("installer failure is reported without claiming installation succeeded", async (t) => {
  const f = await fixture(t);
  const result = f.call(["--runtime", "codex"], {
    KIOKU_TEST_INSTALL_FAIL: "1",
  });
  assert.equal(result.status, 1);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PROCESS_FAILED");
  assert.match(result.error.message, /installer unavailable/);
});
