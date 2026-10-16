import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  Config,
  Envelope,
  Invitation,
  Receipt,
  Failure,
  requireThat,
  validId,
  exists,
  load,
  save,
  createKeys,
  signed,
  verified,
  sha,
  atomicJson,
  validateRoots,
  writeDocument,
  rawPath,
  readJson,
} from "./core.js";
import { seedRaw, FileEntry } from "./files.js";
import { setupSync, endpoint, reconcile } from "./sync.js";
import { start } from "./services.js";

export interface InitOptions {
  agent?: string;
  root: string;
  address: string;
  service: "native" | "manual";
  guiPort?: number;
  listenPort?: number;
}
async function layout(c: Config, home: string) {
  await mkdir(join(c.root, "shared"), { recursive: true });
  if (c.mode === "hub") {
    await atomicJson(join(c.root, "shared", ".kioku-shared.json"), {
      networkId: c.networkId,
    });
    for (const name of ["profile", "projects", "topics"])
      await mkdir(join(c.root, "shared", name), { recursive: true });
    const index = join(c.root, "shared", "INDEX.md");
    if (!(await exists(index)))
      await writeFile(
        index,
        "# Shared knowledge\n\n- profile/ — personal information and preferences\n- projects/ — project context and decisions\n- topics/ — reusable knowledge\n",
        { flag: "wx" },
      );
  }
  await reconcile(c);
}
export async function initialize(home: string, o: InitOptions) {
  if (o.agent) validId(o.agent);
  const root = await validateRoots(home, o.root);
  const address = endpoint(o.address);
  if (await exists(join(home, "config.json"))) {
    const c = await load(home);
    requireThat(
      c.mode === "hub" &&
        c.root === root &&
        c.hubAddress === address &&
        (!o.agent ||
          c.agents.some((a) => a.id === o.agent && a.role === "leader")),
      "ALREADY_INITIALIZED",
      "Existing node configuration differs; no data was changed.",
    );
    await layout(c, home);
    if (c.serviceMode === "native") await start(c, home);
    return c;
  }
  await mkdir(home, { recursive: true, mode: 0o700 });
  const { sync, deviceId } = await setupSync(
    home,
    o.guiPort,
    o.listenPort ?? Number(new URL(address).port),
  );
  const publicKey = await createKeys(home);
  const c: Config = {
    version: 1,
    networkId: randomUUID(),
    mode: "hub",
    root,
    deviceId,
    hubDeviceId: deviceId,
    hubAddress: address,
    publicKey,
    agents: o.agent
      ? [{ id: o.agent, role: "leader", deviceId, active: true, local: true }]
      : [],
    peers: [],
    invitations: {},
    receipts: {},
    sync,
    serviceMode: o.service,
  };
  await save(home, c);
  await layout(c, home);
  if (c.serviceMode === "native") await start(c, home);
  return c;
}
export function hubOnly(c: Config) {
  requireThat(
    c.mode === "hub",
    "HUB_REQUIRED",
    "This operation must run on the Hub.",
  );
}
export async function invite(
  home: string,
  c: Config,
  agentId: string | undefined,
  out: string,
) {
  hubOnly(c);
  if (agentId) validId(agentId);
  requireThat(
    !c.agents.some((a) => a.id === agentId && a.active),
    "AGENT_EXISTS",
    "An active writer already owns this Agent. Retire it before inviting a replacement.",
  );
  const pending = Object.values(c.invitations).find(
    (i) =>
      agentId &&
      i.envelope.payload.agentId === agentId &&
      !i.revoked &&
      !i.consumedBy,
  );
  const retired = c.agents.find((a) => a.id === agentId && !a.active);
  requireThat(
    !retired || retired.seedHash,
    "MIGRATION_REQUIRED",
    "A retired identity requires a migration bundle before it can be reused.",
  );
  const envelope =
    pending?.envelope ||
    (await signed<Invitation>(home, {
      version: 1,
      kind: "invitation",
      id: randomUUID(),
      networkId: c.networkId,
      agentId,
      hubDeviceId: c.deviceId,
      hubAddress: c.hubAddress,
      hubPublicKey: c.publicKey,
      issuedAt: new Date().toISOString(),
      ...(retired?.seedHash ? { seedHash: retired.seedHash } : {}),
    }));
  c.invitations[envelope.payload.id] ||= { envelope };
  await save(home, c);
  await writeDocument(resolve(out), envelope);
  return {
    invitation: resolve(out),
    agentId,
    hubDeviceId: c.deviceId,
    networkId: c.networkId,
  };
}
export function validateInvitation(envelope: Envelope<Invitation>): Invitation {
  const i = verified(envelope, envelope?.payload?.hubPublicKey);
  requireThat(
    i.version === 1 &&
      i.kind === "invitation" &&
      /^[a-f0-9-]{36}$/.test(i.networkId) &&
      /^[a-f0-9-]{36}$/.test(i.id),
    "INVALID_INVITATION",
    "Unsupported invitation.",
  );
  if (i.agentId) validId(i.agentId);
  endpoint(i.hubAddress);
  requireThat(
    /^[A-Z2-7]{7}(-[A-Z2-7]{7}){7}$/.test(i.hubDeviceId),
    "INVALID_INVITATION",
    "Invalid Hub device ID.",
  );
  return i;
}
export async function joinNetwork(
  home: string,
  invitationPath: string,
  rootInput: string,
  out: string,
  service: "native" | "manual",
  guiPort?: number,
  listenPort?: number,
  seed?: string,
) {
  const envelope = await readFile(invitationPath, "utf8").then(
    (s) => JSON.parse(s) as Envelope<Invitation>,
  );
  const i = validateInvitation(envelope);
  const root = await validateRoots(home, rootInput);
  let c: Config;
  if (await exists(join(home, "config.json"))) {
    c = await load(home);
    requireThat(
      c.networkId === i.networkId &&
        c.hubDeviceId === i.hubDeviceId &&
        c.hubAddress === i.hubAddress &&
        (c.mode === "hub"
          ? c.publicKey
          : c.peers.find((p) => p.deviceId === i.hubDeviceId)?.publicKey) ===
          i.hubPublicKey &&
        c.root === root,
      "NETWORK_MISMATCH",
      "Invitation does not match this node network or root.",
    );
  } else {
    await mkdir(home, { recursive: true, mode: 0o700 });
    const { sync, deviceId } = await setupSync(
      home,
      guiPort,
      listenPort ?? 22000,
    );
    const publicKey = await createKeys(home);
    c = {
      version: 1,
      networkId: i.networkId,
      mode: "node",
      root,
      deviceId,
      hubDeviceId: i.hubDeviceId,
      hubAddress: i.hubAddress,
      publicKey,
      agents: [],
      peers: [{ deviceId: i.hubDeviceId, publicKey: i.hubPublicKey }],
      invitations: {},
      receipts: {},
      sync,
      serviceMode: service,
    };
  }
  if (c.mode === "hub") {
    const issued = c.invitations[i.id];
    requireThat(
      issued &&
        !issued.revoked &&
        JSON.stringify(issued.envelope) === JSON.stringify(envelope) &&
        (!issued.consumedBy || issued.consumedBy === c.deviceId),
      "UNKNOWN_INVITATION",
      "Hub local registration requires an unused invitation issued by this Hub.",
    );
  }
  if (i.agentId) {
    const existing = c.agents.find((a) => a.id === i.agentId);
    requireThat(
      !existing || existing.active || (i.seedHash && !c.receipts[i.id]),
      "AGENT_RETIRED",
      "Retired identity requires an explicit migration, not an old invitation.",
    );
    requireThat(
      !existing?.active || existing.local,
      "WRITER_CONFLICT",
      "Another device already owns this identity.",
    );
    if (i.seedHash && !c.receipts[i.id]) {
      requireThat(
        seed,
        "MIGRATION_SEED_REQUIRED",
        "This invitation requires --seed pointing to the migration bundle.",
      );
      const m = await readJson<{ files: FileEntry[] }>(
        join(seed, "manifest.json"),
      );
      requireThat(
        sha(JSON.stringify(m.files)) === i.seedHash,
        "INVALID_SEED",
        "Migration bundle does not match the invitation.",
      );
      await seedRaw(join(seed, "data"), rawPath(c, i.agentId), m.files);
    }
    if (!existing)
      c.agents.push({
        id: i.agentId,
        role: "member",
        deviceId: c.deviceId,
        active: true,
        local: true,
      });
    else {
      existing.active = true;
      existing.local = true;
      existing.deviceId = c.deviceId;
      delete existing.seedHash;
    }
  }
  const receipt =
    c.receipts[i.id] ||
    (await signed<Receipt>(home, {
      version: 1,
      kind: "receipt",
      invitation: envelope,
      deviceId: c.deviceId,
      publicKey: c.publicKey,
    }));
  c.receipts[i.id] = receipt;
  if (c.mode === "hub") c.invitations[i.id]!.consumedBy = c.deviceId;
  await save(home, c);
  await layout(c, home);
  await writeDocument(resolve(out), receipt);
  if (c.serviceMode === "native") await start(c, home);
  return {
    agentId: i.agentId,
    deviceId: c.deviceId,
    receipt: resolve(out),
    enrollment: c.mode === "hub" ? "registered" : "awaiting-hub",
    root: c.root,
  };
}
export async function enroll(home: string, c: Config, path: string) {
  hubOnly(c);
  const envelope = JSON.parse(
    await readFile(path, "utf8"),
  ) as Envelope<Receipt>;
  const r = verified(envelope, envelope?.payload?.publicKey);
  requireThat(
    r.version === 1 && r.kind === "receipt",
    "INVALID_RECEIPT",
    "Unsupported receipt.",
  );
  const i = validateInvitation(r.invitation);
  const issued = c.invitations[i.id];
  requireThat(
    issued &&
      !issued.revoked &&
      i.networkId === c.networkId &&
      JSON.stringify(issued.envelope) === JSON.stringify(r.invitation),
    "UNKNOWN_INVITATION",
    "Invitation is unknown, revoked, or changed.",
  );
  requireThat(
    /^[A-Z2-7]{7}(-[A-Z2-7]{7}){7}$/.test(r.deviceId) &&
      r.deviceId !== c.deviceId,
    "INVALID_RECEIPT",
    "Invalid peer device ID.",
  );
  requireThat(
    !issued.consumedBy || issued.consumedBy === r.deviceId,
    "INVITATION_USED",
    "Invitation was already consumed by a different device.",
  );
  const peer = c.peers.find((p) => p.deviceId === r.deviceId);
  requireThat(
    !peer?.revoked && (!peer || peer.publicKey === r.publicKey),
    "REVOKED_OR_CHANGED_DEVICE",
    "Device was revoked or its signing key changed.",
  );
  if (!peer) c.peers.push({ deviceId: r.deviceId, publicKey: r.publicKey });
  if (i.agentId) {
    const agent = c.agents.find((a) => a.id === i.agentId);
    requireThat(
      !agent ||
        (agent.active && agent.deviceId === r.deviceId) ||
        (!agent.active &&
          agent.seedHash &&
          agent.seedHash === i.seedHash &&
          !issued.consumedBy),
      "WRITER_CONFLICT",
      "This identity is retired or owned by another writer.",
    );
    if (!agent)
      c.agents.push({
        id: i.agentId,
        role: "member",
        active: true,
        local: false,
        deviceId: r.deviceId,
      });
    else if (!agent.active) {
      agent.active = true;
      agent.local = false;
      agent.deviceId = r.deviceId;
      delete agent.seedHash;
    }
  }
  issued.consumedBy = r.deviceId;
  await save(home, c);
  await reconcile(c);
  return { agentId: i.agentId, deviceId: r.deviceId, enrollment: "registered" };
}

export async function addSource(
  home: string,
  c: Config,
  id: string,
  role: "member" | "leader" = "member",
) {
  validId(id);
  if (role === "leader") hubOnly(c);
  const old = c.agents.find((a) => a.id === id);
  requireThat(
    !old || (old.local && old.active && old.role === role),
    "WRITER_CONFLICT",
    "Source already belongs to another writer, is retired, or has a different role.",
  );
  if (old) return old;
  if (role === "leader")
    requireThat(
      !c.agents.some((a) => a.active && a.role === "leader"),
      "LEADER_EXISTS",
      "This network already has a Leader.",
    );
  const source: Config["agents"][number] = {
    id,
    role,
    deviceId: c.deviceId,
    local: true,
    active: true,
    registration: c.mode === "hub" ? "registered" : "pending",
  };
  await mkdir(rawPath(c, id), { recursive: true });
  c.agents.push(source);
  await save(home, c);
  await reconcile(c);
  return source;
}
