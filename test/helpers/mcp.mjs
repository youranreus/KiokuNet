import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { save } from "../../dist/core.js";
import { defaults, createKey } from "../../dist/mcp/config.js";
import { startMcpServer } from "../../dist/mcp/server.js";
import { removeFixture } from "./files.mjs";

export const writerPermissions = {
  readSpaces: [],
  writeSpaces: ["writer"],
  shared: "read",
};
export const curatorPermissions = {
  readSpaces: "*",
  writeSpaces: [],
  shared: "read-write",
};
export const permissionsFor = (name = "writer") =>
  name === "curator"
    ? curatorPermissions
    : { readSpaces: [], writeSpaces: [name], shared: "read" };

export function cli(home, args) {
  const env = { ...process.env, KIOKU_SYNCTHING: resolve(".tools/syncthing") };
  delete env.KIOKU_SPACE_ID;
  const r = spawnSync(
    process.execPath,
    [resolve("dist/cli.js"), ...args, "--home", home, "--json"],
    { env, encoding: "utf8", timeout: 30000 },
  );
  if (!r.stdout) throw new Error(r.stderr || String(r.error));
  return JSON.parse(r.stdout);
}
export async function connect(url, token) {
  const client = new Client({ name: "kioku-acceptance", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}
export async function call(client, name, args) {
  const response = await client.callTool({ name, arguments: args });
  return {
    isError: response.isError || false,
    ...JSON.parse(response.content[0].text),
  };
}
export async function fixture(t, mcpSettings = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "kioku-mcp-"))),
    home = join(dir, "config");
  const clients = [];
  let server;
  t.after(async () => {
    await Promise.allSettled(clients.map((c) => c.close()));
    await server?.close();
    await removeFixture(dir);
  });
  const c = {
    version: 2,
    networkId: "test",
    mode: "hub",
    root: join(dir, "data"),
    deviceId: "hub-device",
    hubDeviceId: "hub-device",
    hubAddress: "tcp://127.0.0.1:22000",
    publicKey: "",
    peers: [],
    invitations: {},
    receipts: {},
    serviceMode: "manual",
    sync: {},
    spaces: [
      {
        id: "writer",
        deviceId: "hub-device",
        local: true,
        active: true,
        registration: "registered",
      },
      {
        id: "other",
        deviceId: "hub-device",
        local: true,
        active: true,
        registration: "registered",
      },
      {
        id: "notes",
        deviceId: "hub-device",
        local: true,
        active: true,
        registration: "registered",
      },
      {
        id: "remote",
        deviceId: "remote-device",
        local: false,
        active: true,
        registration: "registered",
      },
    ],
    mcp: {
      ...defaults,
      enabled: true,
      host: "127.0.0.1",
      keys: [],
      ...mcpSettings,
    },
  };
  for (const a of c.spaces)
    await mkdir(join(c.root, "spaces", a.id), { recursive: true });
  await mkdir(join(c.root, "shared"));
  await writeFile(join(c.root, "shared", "INDEX.md"), "Shared knowledge\n");
  await save(home, c);
  const member = await createKey(home, c, writerPermissions),
    leader = await createKey(home, c, curatorPermissions);
  server = await startMcpServer(home, { ...c.mcp, port: 0 });
  const url = `http://127.0.0.1:${server.address.port}/mcp`;
  const clientFor = async (token) => {
    const client = await connect(url, token);
    clients.push(client);
    return client;
  };
  return {
    dir,
    home,
    c,
    writer: member,
    curator: leader,
    url,
    server,
    clientFor,
    writerClient: await clientFor(member.token),
    curatorClient: await clientFor(leader.token),
  };
}
