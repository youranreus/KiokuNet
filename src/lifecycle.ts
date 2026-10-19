import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  Config,
  Envelope,
  requireThat,
  save,
  atomicJson,
  signed,
  verified,
  readJson,
  exists,
  canonical,
  inside,
  sha,
  spacePath,
} from "./core.js";
import { unmapDirectory } from "./mappings.js";
import { reconcile } from "./sync.js";
import { copyVerified, FileEntry } from "./files.js";
import { hubOnly, invite } from "./network.js";

export async function retire(home: string, c: Config, spaceId: string) {
  const a = c.spaces.find((a) => a.id === spaceId);
  requireThat(a, "INVALID_SPACE", "Only a registered space can be retired.");
  for (const w of [...(c.mappings || [])].filter((w) => w.spaceId === spaceId))
    await unmapDirectory(home, c, w.path);
  a.active = false;
  for (const invitation of Object.values(c.invitations))
    if (invitation.envelope.payload.spaceId === spaceId)
      invitation.revoked = true;
  await save(home, c);
  await reconcile(c);
  return {
    spaceId,
    active: false,
    knowledgePreserved: true,
    next:
      c.mode === "node"
        ? "Also retire this Space on the Hub to remove its sharing relationship."
        : "Stop use of this space on its original node.",
  };
}
export async function revoke(home: string, c: Config, deviceId: string) {
  hubOnly(c);
  const peer = c.peers.find((p) => p.deviceId === deviceId);
  requireThat(peer, "UNKNOWN_DEVICE", "Device is not registered.");
  for (const w of [...(c.mappings || [])].filter((w) =>
    c.spaces.some((a) => a.id === w.spaceId && a.deviceId === deviceId),
  ))
    await unmapDirectory(home, c, w.path);
  peer.revoked = true;
  for (const a of c.spaces.filter((a) => a.deviceId === deviceId)) {
    a.active = false;
    for (const i of Object.values(c.invitations))
      if (i.envelope.payload.spaceId === a.id) i.revoked = true;
  }
  await save(home, c);
  await reconcile(c);
  return {
    deviceId,
    revoked: true,
    knowledgePreserved: true,
    cachedCopiesErased: false,
  };
}
interface Migration {
  version: 2;
  kind: "migration";
  spaceId: string;
  networkId: string;
  deviceId: string;
  publicKey: string;
  files: FileEntry[];
}
export async function exportMigration(
  home: string,
  c: Config,
  spaceId: string,
  target: string,
) {
  const a = c.spaces.find((a) => a.id === spaceId && a.local);
  requireThat(a, "INVALID_SPACE", "Migration export requires a local space.");
  target = await canonical(target);
  requireThat(
    !(await exists(target)),
    "OUTPUT_EXISTS",
    "Choose a new migration bundle directory.",
  );
  for (const p of [c.root, home])
    requireThat(
      !inside(p, target) && !inside(target, p),
      "OVERLAPPING_PATHS",
      "Migration bundle must be outside knowledge and private configuration.",
    );
  await retire(home, c, spaceId);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const files = await copyVerified(spacePath(c, spaceId), join(target, "data"));
  await atomicJson(join(target, "manifest.json"), { files });
  const receipt = await signed<Migration>(home, {
    version: 2,
    kind: "migration",
    spaceId,
    networkId: c.networkId,
    deviceId: c.deviceId,
    publicKey: c.publicKey,
    files,
  });
  await atomicJson(join(target, "migration.json"), receipt);
  return {
    target,
    retired: true,
    next: "Transfer migration.json to Hub; run space migrate --receipt FILE --out INVITE. Transfer the full bundle to the new node and join with --seed DIR.",
  };
}
export async function acceptMigration(
  home: string,
  c: Config,
  receipt: string,
  out: string,
  confirmedId: string,
) {
  hubOnly(c);
  const envelope = await readJson<Envelope<Migration>>(receipt);
  const m = verified(envelope, envelope?.payload?.publicKey);
  const space = c.spaces.find((a) => a.id === m.spaceId),
    peer = c.peers.find((p) => p.deviceId === m.deviceId);
  requireThat(
    m.kind === "migration" &&
      m.version === 2 &&
      m.networkId === c.networkId &&
      space &&
      space.deviceId === m.deviceId &&
      (m.deviceId === c.deviceId
        ? c.publicKey === m.publicKey
        : peer?.publicKey === m.publicKey && !peer.revoked),
    "INVALID_MIGRATION",
    "Migration does not match the registered writer.",
  );
  requireThat(
    confirmedId === m.spaceId,
    "CONFIRMATION_REQUIRED",
    "Confirmation must match the migrating Space.",
  );
  if (!space.active && space.seedHash === sha(JSON.stringify(m.files)))
    return invite(home, c, space.id, out);
  await retire(home, c, space.id);
  space.seedHash = sha(JSON.stringify(m.files));
  await save(home, c);
  return invite(home, c, space.id, out);
}
