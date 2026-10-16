import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const cli = resolve("dist/cli.js");
test(
  "pinned skills installer distributes bundled skills in an isolated project",
  { skip: process.env.KIOKU_TEST_SKILLS !== "1", timeout: 120000 },
  async () => {
    const d = await mkdtemp(join(tmpdir(), "kioku-skills-"));
    const env = {
      ...process.env,
      KIOKU_SYNCTHING:
        process.env.KIOKU_SYNCTHING || resolve(".tools/syncthing"),
    };
    delete env.KIOKU_AGENT_ID;
    const call = (args) => {
      const result = spawnSync(
        process.execPath,
        [cli, ...args, "--home", join(d, "config"), "--json"],
        { cwd: d, env, encoding: "utf8", timeout: 110000 },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stdout || result.stderr);
      return JSON.parse(result.stdout);
    };
    try {
      // The usage guide must be installable before creating a network.
      for (const runtime of ["codex", "hermes-agent"]) {
        const installed = call([
          "skill",
          "install",
          "--runtime",
          runtime,
          "--scope",
          "project",
        ]);
        assert.equal(installed.ok, true, JSON.stringify(installed));
        assert.deepEqual(installed.data.skills, ["kioku"]);
      }
      assert.equal(
        call([
          "init",
          "--agent",
          "leader",
          "--root",
          join(d, "config", "data"),
          "--address",
          "127.0.0.1:23450",
          "--service",
          "manual",
        ]).ok,
        true,
      );
      for (const runtime of ["codex", "hermes-agent"]) {
        const installed = call([
          "skill",
          "install",
          "--runtime",
          runtime,
          "--scope",
          "project",
          "--skill",
          "kioku-curate",
        ]);
        assert.equal(installed.ok, true, JSON.stringify(installed));
        assert.deepEqual(installed.data.skills, ["kioku-curate"]);
      }
      for (const skill of ["kioku", "kioku-curate"]) {
        const installed = await readFile(
          join(d, ".agents", "skills", skill, "SKILL.md"),
          "utf8",
        );
        assert.equal(
          installed,
          await readFile(resolve("skills", skill, "SKILL.md"), "utf8"),
        );
        assert.ok(!installed.includes(d));
        const hermes = await readFile(
          join(d, ".hermes", "skills", skill, "SKILL.md"),
          "utf8",
        );
        assert.equal(hermes, installed);
      }
      for (const file of [
        "setup.md",
        "workspaces.md",
        "operations.md",
        "lifecycle.md",
      ]) {
        const expected = await readFile(
          resolve("skills/kioku/references", file),
          "utf8",
        );
        for (const folder of [".agents", ".hermes"]) {
          assert.equal(
            await readFile(
              join(d, folder, "skills/kioku/references", file),
              "utf8",
            ),
            expected,
          );
        }
      }
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  },
);
