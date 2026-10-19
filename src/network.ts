import { mkdir, readFile } from "node:fs/promises";
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
  spacePath,
  readJson,
} from "./core.js";
import { seedSpace, FileEntry } from "./files.js";
import { setupSync, endpoint, reconcile } from "./sync.js";
import { start } from "./services.js";

export interface InitOptions {
  root: string;
  address: string;
  service: "native" | "manual";
  guiPort?: number;
  listenPort?: number;
}
async function layout(c: Config, home: string) {
  await mkdir(join(c.root, "shared"), { recursive: true });
  await mkdir(join(c.root, "spaces"), { recursive: true });
  if (c.mode === "hub") {
    await atomicJson(join(c.root, "shared", ".kioku-shared.json"), {
      networkId: c.networkId,
    });
  }
  await reconcile(c);
}
export async function initialize(home: string, o: InitOptions) {
  const root = await validateRoots(home, o.root);
  const address = endpoint(o.address);
  if (await exists(join(home, "config.json"))) {
    const c = await load(home);
    requireThat(
      c.mode === "hub" && c.root === root && c.hubAddress === address,
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
    version: 2,
    networkId: randomUUID(),
    mode: "hub",
    root,
    deviceId,
    hubDeviceId: deviceId,
    hubAddress: address,
    publicKey,
    spaces: [],
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
  spaceId: string | undefined,
  out: string,
) {
  hubOnly(c);
  if (spaceId) validId(spaceId);
  requireThat(
    !c.spaces.some((a) => a.id === spaceId && a.active),
    "SPACE_EXISTS",
    "An active writer already owns this Space. Retire it before inviting a replacement.",
  );
  const pending = Object.values(c.invitations).find(
    (i) =>
      spaceId &&
      i.envelope.payload.spaceId === spaceId &&
      !i.revoked &&
      !i.consumedBy,
  );
  const retired = c.spaces.find((a) => a.id === spaceId && !a.active);
  requireThat(
    !retired || retired.seedHash,
    "MIGRATION_REQUIRED",
    "A retired space requires a migration bundle before it can be reused.",
  );
  const envelope =
    pending?.envelope ||
    (await signed<Invitation>(home, {
      version: 2,
      kind: "invitation",
      id: randomUUID(),
      networkId: c.networkId,
      spaceId,
      hubDeviceId: c.deviceId,
      hubAddress: c.hubAddress,
      hubPublicKey: c.publicKey,
      issuedAt: new Date().toISOString(),
      ...(retired?.seedHash ? { seedHash: retired.seedHash } : {}),
      ...(retired?.syncFolderId ? { syncFolderId: retired.syncFolderId } : {}),
    }));
  c.invitations[envelope.payload.id] ||= { envelope };
  await save(home, c);
  await writeDocument(resolve(out), envelope);
  return {
    invitation: resolve(out),
    spaceId,
    hubDeviceId: c.deviceId,
    networkId: c.networkId,
  };
}
export function validateInvitation(envelope: Envelope<Invitation>): Invitation {
  const i = verified(envelope, envelope?.payload?.hubPublicKey);
  requireThat(
    i.version === 2 &&
      i.kind === "invitation" &&
      /^[a-f0-9-]{36}$/.test(i.networkId) &&
      /^[a-f0-9-]{36}$/.test(i.id),
    "INVALID_INVITATION",
    "Unsupported invitation.",
  );
  if (i.spaceId) validId(i.spaceId);
  if (i.syncFolderId)
    requireThat(
      i.spaceId && i.syncFolderId === `kioku-${i.networkId}-raw-${i.spaceId}`,
      "INVALID_INVITATION",
      "Invalid retained sync folder ID.",
    );
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
      version: 2,
      networkId: i.networkId,
      mode: "node",
      root,
      deviceId,
      hubDeviceId: i.hubDeviceId,
      hubAddress: i.hubAddress,
      publicKey,
      spaces: [],
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
  if (i.spaceId) {
    const existing = c.spaces.find((a) => a.id === i.spaceId);
    requireThat(
      !existing || existing.active || (i.seedHash && !c.receipts[i.id]),
      "SPACE_RETIRED",
      "Retired space requires an explicit migration, not an old invitation.",
    );
    requireThat(
      !existing?.active || existing.local,
      "WRITER_CONFLICT",
      "Another device already owns this space.",
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
      await seedSpace(join(seed, "data"), spacePath(c, i.spaceId), m.files);
    }
    if (!existing)
      c.spaces.push({
        id: i.spaceId,
        ...(i.syncFolderId ? { syncFolderId: i.syncFolderId } : {}),
        deviceId: c.deviceId,
        active: true,
        local: true,
      });
    else {
      existing.active = true;
      existing.local = true;
      existing.deviceId = c.deviceId;
      existing.syncFolderId = i.syncFolderId;
      delete existing.seedHash;
    }
  }
  const receipt =
    c.receipts[i.id] ||
    (await signed<Receipt>(home, {
      version: 2,
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
    spaceId: i.spaceId,
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
    r.version === 2 && r.kind === "receipt",
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
  if (i.spaceId) {
    const space = c.spaces.find((a) => a.id === i.spaceId);
    requireThat(
      !space ||
        (space.active && space.deviceId === r.deviceId) ||
        (!space.active &&
          space.seedHash &&
          space.seedHash === i.seedHash &&
          !issued.consumedBy),
      "WRITER_CONFLICT",
      "This space is retired or owned by another writer.",
    );
    if (!space)
      c.spaces.push({
        id: i.spaceId,
        active: true,
        local: false,
        deviceId: r.deviceId,
      });
    else if (!space.active) {
      space.active = true;
      space.local = false;
      space.deviceId = r.deviceId;
      delete space.seedHash;
    }
  }
  issued.consumedBy = r.deviceId;
  await save(home, c);
  await reconcile(c);
  return { spaceId: i.spaceId, deviceId: r.deviceId, enrollment: "registered" };
}

export async function addSpace(home: string, c: Config, id: string) {
  validId(id);
  const old = c.spaces.find((s) => s.id === id);
  requireThat(
    !old || (old.local && old.active),
    "WRITER_CONFLICT",
    "Space already belongs to another writer or is retired.",
  );
  if (old) return old;
  const space: Config["spaces"][number] = {
    id,
    deviceId: c.deviceId,
    local: true,
    active: true,
    registration: c.mode === "hub" ? "registered" : "pending",
  };
  await mkdir(spacePath(c, id), { recursive: true });
  c.spaces.push(space);
  await save(home, c);
  await reconcile(c);
  return space;
}
