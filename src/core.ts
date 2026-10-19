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
    "Identifiers must use 1–64 lowercase letters, digits, _ or -.",
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
export interface Space {
  id: string;
  deviceId: string;
  active: boolean;
  local: boolean;
  seedHash?: string;
  registration?: "pending" | "registered" | "conflict";
  registrationError?: string;
  authorizationRevision?: string;
  syncFolderId?: string;
}
export interface Peer {
  deviceId: string;
  publicKey: string;
  revoked?: boolean;
}
export interface Invitation {
  version: 2;
  kind: "invitation";
  id: string;
  networkId: string;
  spaceId?: string;
  hubDeviceId: string;
  hubAddress: string;
  hubPublicKey: string;
  issuedAt: string;
  seedHash?: string;
  syncFolderId?: string;
}
export interface Envelope<T> {
  payload: T;
  signature: string;
}
export interface Receipt {
  version: 2;
  kind: "receipt";
  invitation: Envelope<Invitation>;
  deviceId: string;
  publicKey: string;
}
export interface DirectoryMapping {
  kind: "space" | "shared" | "spaces";
  spaceId?: string;
  path: string;
  writable: boolean;
}
export interface Config {
  version: 2;
  networkId: string;
  mode: "hub" | "node";
  root: string;
  deviceId: string;
  hubDeviceId: string;
  hubAddress: string;
  publicKey: string;
  spaces: Space[];
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
  mappings?: DirectoryMapping[];
  mcp?: McpConfig;
  oauthRevision?: string;
}
export async function load(home: string): Promise<Config> {
  const file = join(home, "config.json");
  if (!(await exists(file)))
    throw new Failure("NOT_INITIALIZED", "Run kioku init or join first.");
  const upgrade = join(home, "upgrade-v2.json");
  if (await exists(upgrade))
    requireThat(
      (await readJson<{ completed?: boolean }>(upgrade)).completed,
      "UPGRADE_IN_PROGRESS",
      "Resume kioku upgrade apply before starting services or accessing knowledge.",
    );
  const c = await readJson<Config>(file);
  requireThat(
    c.version === 2 && Array.isArray(c.spaces),
    "UPGRADE_REQUIRED",
    "Unsupported configuration. For version 1 run kioku upgrade plan, then upgrade apply after stopping services.",
  );
  return c;
}
export async function save(home: string, c: Config) {
  // A disable/re-enable or ownership round trip must not resurrect grants.
  let previous: Config | undefined;
  try {
    previous = await readJson<Config>(join(home, "config.json"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  c.oauthRevision =
    previous && previous.mcp?.publicUrl === c.mcp?.publicUrl
      ? previous.oauthRevision || randomUUID()
      : randomUUID();
  const fingerprint = (config: Config, a: Space) =>
    JSON.stringify([
      config.networkId,
      config.deviceId,
      config.root,
      config.mode,
      a.id,
      a.deviceId,
      a.local,
      a.active,
      a.registration === "conflict",
    ]);
  for (const space of c.spaces) {
    const old = previous?.spaces?.find((a) => a.id === space.id);
    space.authorizationRevision =
      previous && old && fingerprint(previous, old) === fingerprint(c, space)
        ? old.authorizationRevision || randomUUID()
        : randomUUID();
  }
  await atomicJson(join(home, "config.json"), c);
}
export const spacePath = (c: Config, id: string) =>
  join(c.root, "spaces", validId(id));
export function spaceInfo(c: Config, id: string) {
  const space = c.spaces.find((s) => s.id === id);
  requireThat(space, "UNKNOWN_SPACE", "Unknown knowledge space.");
  return { ...space, path: spacePath(c, id) };
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
