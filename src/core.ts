import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  realpath,
  stat,
} from "node:fs/promises";
import { join, resolve, relative, isAbsolute, dirname } from "node:path";
import { homedir } from "node:os";
import {
  randomUUID,
  createHash,
  generateKeyPairSync,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import type { McpConfig } from "./mcp/config.js";

export class Failure extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
    public exit = 2,
  ) {
    super(message);
  }
}
export function requireThat(
  value: unknown,
  code: string,
  message: string,
): asserts value {
  if (!value) throw new Failure(code, message);
}
export const idPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export function validId(id: string): string {
  requireThat(
    typeof id === "string" && idPattern.test(id),
    "INVALID_ID",
    "Identity must use 1–64 lowercase letters, digits, _ or -.",
  );
  return id;
}
export function stateHome(arg?: string): string {
  return join(
    resolve(arg || process.env.KIOKU_HOME || join(homedir(), ".kiokunet")),
    "config",
  );
}
export const sha = (input: string | Buffer) =>
  createHash("sha256").update(input).digest("hex");
export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function withLock<T>(
  home: string,
  work: () => Promise<T>,
  waitMs = 5000,
): Promise<T> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = join(home, "mutation.lock");
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await mkdir(path);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (Date.now() >= deadline)
        throw new Failure(
          "LOCKED",
          `Another operation holds ${path}. If its process exited, remove this lock directory manually.`,
        );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    await writeFile(
      join(path, "owner.json"),
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
    );
    return await work();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}
export function inside(parent: string, child: string): boolean {
  const r = relative(parent, child);
  return (
    r === "" || (!r.startsWith(".." + "/") && r !== ".." && !isAbsolute(r))
  );
}
export async function canonical(path: string): Promise<string> {
  path = resolve(path);
  try {
    return await realpath(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return join(
      await canonical(dirname(path)),
      path.substring(dirname(path).length + 1),
    );
  }
}
export async function validateRoots(
  home: string,
  root: string,
): Promise<string> {
  const h = await canonical(home),
    r = await canonical(root);
  requireThat(
    r === (await canonical(join(dirname(home), "data"))),
    "INSTALL_ROOT_REQUIRED",
    "Knowledge must be under <installation>/data. Set --home to change the installation root.",
  );
  requireThat(
    !inside(h, r) && !inside(r, h),
    "OVERLAPPING_PATHS",
    "Knowledge root and private configuration directory must not overlap.",
  );
  return r;
}
export interface Agent {
  id: string;
  role: "leader" | "member";
  deviceId: string;
  active: boolean;
  local: boolean;
  seedHash?: string;
  registration?: "pending" | "registered" | "conflict";
  registrationError?: string;
  authorizationRevision?: string;
}
export interface Peer {
  deviceId: string;
  publicKey: string;
  revoked?: boolean;
}
export interface Invitation {
  version: 1;
  kind: "invitation";
  id: string;
  networkId: string;
  agentId?: string;
  hubDeviceId: string;
  hubAddress: string;
  hubPublicKey: string;
  issuedAt: string;
  seedHash?: string;
}
export interface Envelope<T> {
  payload: T;
  signature: string;
}
export interface Receipt {
  version: 1;
  kind: "receipt";
  invitation: Envelope<Invitation>;
  deviceId: string;
  publicKey: string;
}
export interface Workspace {
  sourceId: string;
  raw: string;
  shared: string;
  allRaw?: string;
}
export interface Config {
  version: 1;
  networkId: string;
  mode: "hub" | "node";
  root: string;
  deviceId: string;
  hubDeviceId: string;
  hubAddress: string;
  publicKey: string;
  agents: Agent[];
  peers: Peer[];
  invitations: Record<
    string,
    { envelope: Envelope<Invitation>; consumedBy?: string; revoked?: boolean }
  >;
  receipts: Record<string, Envelope<Receipt>>;
  serviceMode: "native" | "manual";
  sync: {
    binary: string;
    home: string;
    apiKey: string;
    guiPort: number;
    listenPort: number;
  };
  workspaces?: Workspace[];
  mcp?: McpConfig;
}
export async function load(home: string): Promise<Config> {
  const file = join(home, "config.json");
  if (!(await exists(file)))
    throw new Failure("NOT_INITIALIZED", "Run kioku init or join first.");
  const c = await readJson<Config>(file);
  requireThat(
    c.version === 1 && Array.isArray(c.agents),
    "INVALID_CONFIG",
    "Unsupported or invalid KiokuNet configuration.",
  );
  return c;
}
export async function save(home: string, c: Config) {
  // A disable/re-enable or role/ownership round trip must not resurrect grants.
  let previous: Config | undefined;
  try {
    previous = await readJson<Config>(join(home, "config.json"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const fingerprint = (config: Config, a: Agent) =>
    JSON.stringify([
      config.networkId,
      config.deviceId,
      config.root,
      config.mode,
      config.mcp?.publicUrl,
      a.id,
      a.role,
      a.deviceId,
      a.local,
      a.active,
      a.registration === "conflict",
    ]);
  for (const agent of c.agents) {
    const old = previous?.agents.find((a) => a.id === agent.id);
    agent.authorizationRevision =
      previous && old && fingerprint(previous, old) === fingerprint(c, agent)
        ? old.authorizationRevision || randomUUID()
        : randomUUID();
  }
  await atomicJson(join(home, "config.json"), c);
}
export function ownAgent(c: Config, explicit?: string): Agent {
  const env = process.env.KIOKU_AGENT_ID;
  requireThat(
    !(env && explicit && env !== explicit),
    "IDENTITY_CONFLICT",
    "--agent conflicts with KIOKU_AGENT_ID.",
  );
  const eligible = c.agents.filter((a) => a.local && a.active);
  const chosen = explicit || env;
  if (!chosen && eligible.length !== 1)
    throw new Failure("IDENTITY_REQUIRED", "Bind an Agent explicitly.", {
      candidates: eligible.map((a) => a.id),
    });
  const a = chosen ? eligible.find((a) => a.id === chosen) : eligible[0];
  requireThat(a, "UNKNOWN_AGENT", "Identity is not an active local Agent.");
  return a;
}
export const rawPath = (c: Config, id: string) =>
  join(c.root, "agents", validId(id), "raw");
export function context(c: Config, home: string, explicit?: string) {
  const a = ownAgent(c, explicit);
  return {
    version: 1,
    networkId: c.networkId,
    agentId: a.id,
    role: a.role,
    deviceId: c.deviceId,
    root: c.root,
    raw: rawPath(c, a.id),
    shared: join(c.root, "shared"),
    ...(a.role === "leader"
      ? {
          allRaw: join(c.root, "agents"),
          progress: join(rawPath(c, a.id), ".kioku-curation"),
        }
      : {}),
  };
}
export async function createKeys(home: string) {
  const path = join(home, "identity.pem");
  if (await exists(path))
    return createPublicKey(await readFile(path))
      .export({ format: "pem", type: "spki" })
      .toString();
  const keys = generateKeyPairSync("ed25519");
  await writeFile(
    path,
    keys.privateKey.export({ format: "pem", type: "pkcs8" }),
    { mode: 0o600, flag: "wx" },
  );
  return keys.publicKey.export({ format: "pem", type: "spki" }).toString();
}
export async function writeDocument(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const contents = JSON.stringify(value, null, 2) + "\n";
  if (await exists(path)) {
    requireThat(
      (await readFile(path, "utf8")) === contents,
      "OUTPUT_EXISTS",
      "Output already exists with different contents; choose a new output file.",
    );
    return;
  }
  await writeFile(path, contents, { mode: 0o600, flag: "wx" });
}
export async function signed<T>(
  home: string,
  payload: T,
): Promise<Envelope<T>> {
  return {
    payload,
    signature: sign(
      null,
      Buffer.from(JSON.stringify(payload)),
      await readFile(join(home, "identity.pem")),
    ).toString("base64"),
  };
}
export function verified<T>(value: Envelope<T>, key: string): T {
  try {
    requireThat(
      value &&
        typeof value.signature === "string" &&
        verify(
          null,
          Buffer.from(JSON.stringify(value.payload)),
          key,
          Buffer.from(value.signature, "base64"),
        ),
      "INVALID_SIGNATURE",
      "Invalid signed document.",
    );
  } catch {
    throw new Failure("INVALID_SIGNATURE", "Invalid signed document.");
  }
  return value.payload;
}

export const registrationPath = (
  c: Config,
  device: string,
  channel: "requests" | "replies",
) => join(dirname(c.root), "state", "registration", device, channel);
