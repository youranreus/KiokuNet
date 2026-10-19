import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  writeFile,
  readFile,
  readlink,
  unlink,
  mkdtemp,
  realpath,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { removeFixture } from "./helpers/files.mjs";
import { save } from "../dist/core.js";
import { createKey } from "../dist/mcp/config.js";
import {
  mapDirectory,
  unmapDirectory,
  checkMappings,
} from "../dist/mappings.js";
import { fixture, call } from "./helpers/mcp.mjs";

const none = { readSpaces: [], writeSpaces: [], shared: "none" };
test("default-deny grants expose no roots; explicit multi-space grants keep Shared independent", async (t) => {
  const f = await fixture(t);
  let grant = await createKey(f.home, f.c, none);
  let client = await f.clientFor(grant.token);
  assert.deepEqual((await call(client, "list_directory", {})).entries, []);
  assert.equal(
    (await call(client, "read_file", { path: "/shared/INDEX.md" })).error.code,
    "FORBIDDEN",
  );
  grant = await createKey(f.home, f.c, {
    ...none,
    readSpaces: ["remote"],
    writeSpaces: ["other", "writer"],
  });
  client = await f.clientFor(grant.token);
  assert.deepEqual(
    (await call(client, "list_directory", { path: "/spaces" })).entries.map(
      (e) => [e.name, e.writable],
    ),
    [
      ["other", true],
      ["remote", false],
      ["writer", true],
    ],
  );
  assert.equal(
    (
      await call(client, "create_file", {
        path: "/spaces/other/new.md",
        content: "ok",
      })
    ).isError,
    false,
  );
  assert.equal(
    (
      await call(client, "create_file", {
        path: "/spaces/remote/no.md",
        content: "no",
      })
    ).error.code,
    "FORBIDDEN",
  );
  assert.equal(
    (await call(client, "read_file", { path: "/shared/INDEX.md" })).error.code,
    "FORBIDDEN",
  );
  await assert.rejects(
    () => createKey(f.home, f.c, { ...none, writeSpaces: ["remote"] }),
    { code: "WRITER_CONFLICT" },
  );
  await assert.rejects(
    () => createKey(f.home, f.c, { ...none, writeSpaces: ["*"] }),
    { code: "INVALID_ID" },
  );
});
test("explicit all-space reads include future spaces while fixed scopes and write rights do not expand", async (t) => {
  const f = await fixture(t);
  const fixed = await createKey(f.home, f.c, {
    ...none,
    readSpaces: ["writer"],
  });
  const fixedClient = await f.clientFor(fixed.token);
  f.c.spaces.push({
    id: "future",
    deviceId: "remote-device",
    local: false,
    active: true,
    registration: "registered",
  });
  await mkdir(join(f.c.root, "spaces/future"));
  await writeFile(join(f.c.root, "spaces/future/note.md"), "new evidence");
  await save(f.home, f.c);
  assert.equal(
    (
      await call(f.curatorClient, "read_file", {
        path: "/spaces/future/note.md",
      })
    ).content,
    "new evidence",
  );
  assert.equal(
    (await call(fixedClient, "read_file", { path: "/spaces/future/note.md" }))
      .error.code,
    "FORBIDDEN",
  );
  assert.equal(
    (
      await call(f.curatorClient, "create_file", {
        path: "/spaces/future/no.md",
        content: "no",
      })
    ).error.code,
    "FORBIDDEN",
  );
});
test("space and Shared mappings are independent, repeatable and preserve source data on removal", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.c.root, "shared/.kioku-shared.json"),
    JSON.stringify({ networkId: f.c.networkId }),
  );
  const project = await realpath(
    await mkdtemp(join(tmpdir(), "kioku-map-target-")),
  );
  t.after(() => removeFixture(project));
  const input = {
    kind: "space",
    spaceId: "writer",
    path: join(project, "notes"),
    writable: true,
  };
  await mapDirectory(f.home, f.c, input);
  await mapDirectory(f.home, f.c, input);
  await mapDirectory(f.home, f.c, {
    ...input,
    path: join(project, "also-notes"),
  });
  await writeFile(join(project, "notes/example"), "kept");
  assert.equal(
    await readFile(join(project, "also-notes/example"), "utf8"),
    "kept",
  );
  const shared = {
    kind: "shared",
    path: join(project, "shared"),
    writable: false,
  };
  await mapDirectory(f.home, f.c, shared);
  await mapDirectory(f.home, f.c, {
    kind: "shared",
    path: join(project, "editable"),
    writable: true,
  });
  assert.equal(
    await readlink(join(project, "editable")),
    join(f.c.root, "shared"),
  );
  await mapDirectory(f.home, f.c, {
    kind: "spaces",
    path: join(project, "all"),
    writable: false,
  });
  assert.equal(
    await readFile(join(project, "all/writer/example"), "utf8"),
    "kept",
  );
  if (process.getuid?.() !== 0)
    await assert.rejects(() =>
      writeFile(join(project, "all/writer/example"), "bad"),
    );
  await unlink(shared.path);
  await mkdir(shared.path);
  assert.equal((await checkMappings(f.home, f.c)).healthy, false);
  await assert.rejects(() => unmapDirectory(f.home, f.c, shared.path), {
    code: "MAPPING_CHANGED",
  });
  assert.equal(
    (await unmapDirectory(f.home, f.c, input.path)).knowledgePreserved,
    true,
  );
  assert.equal(
    await readFile(join(f.c.root, "spaces/writer/example"), "utf8"),
    "kept",
  );
  await assert.rejects(
    () => mapDirectory(f.home, f.c, { ...input, path: shared.path }),
    { code: "MAPPING_CONFLICT" },
  );
});
