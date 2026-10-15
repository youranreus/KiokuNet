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
  rawPath,
} from "./core.js";
import { detachWorkspace } from "./workspace.js";
import { reconcile } from "./sync.js";
import { copyVerified, FileEntry } from "./files.js";
import { hubOnly, invite } from "./network.js";

export async function retire(home: string, c: Config, agentId: string) {
  const a = c.agents.find((a) => a.id === agentId);
  requireThat(
    a && a.role !== "leader",
    "INVALID_AGENT",
    "Only a registered non-Leader Agent can be retired.",
  );
  for (const w of [...(c.workspaces || [])].filter(
    (w) => w.sourceId === agentId,
  ))
    await detachWorkspace(home, c, w.raw);
  a.active = false;
  for (const invitation of Object.values(c.invitations))
    if (invitation.envelope.payload.agentId === agentId)
      invitation.revoked = true;
  await save(home, c);
  await reconcile(c);
  return {
    agentId,
    active: false,
    knowledgePreserved: true,
    next:
      c.mode === "node"
        ? "Also retire this Agent on the Hub to remove its sharing relationship."
        : "Stop use of this identity on its original node.",
  };
}
export async function revoke(home: string, c: Config, deviceId: string) {
  hubOnly(c);
  const peer = c.peers.find((p) => p.deviceId === deviceId);
  requireThat(peer, "UNKNOWN_DEVICE", "Device is not registered.");
  for (const w of [...(c.workspaces || [])].filter((w) =>
    c.agents.some((a) => a.id === w.sourceId && a.deviceId === deviceId),
  ))
    await detachWorkspace(home, c, w.raw);
  peer.revoked = true;
  for (const a of c.agents.filter((a) => a.deviceId === deviceId)) {
    a.active = false;
    for (const i of Object.values(c.invitations))
      if (i.envelope.payload.agentId === a.id) i.revoked = true;
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
  version: 1;
  kind: "migration";
  agentId: string;
  networkId: string;
  deviceId: string;
  publicKey: string;
  files: FileEntry[];
}
export async function exportMigration(
  home: string,
  c: Config,
  agentId: string,
  target: string,
) {
  const a = c.agents.find((a) => a.id === agentId && a.local);
  requireThat(
    a && a.role === "member",
    "INVALID_AGENT",
    "Migration export requires a local non-Leader Agent.",
  );
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
  await retire(home, c, agentId);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const files = await copyVerified(rawPath(c, agentId), join(target, "data"));
  await atomicJson(join(target, "manifest.json"), { files });
  const receipt = await signed<Migration>(home, {
    version: 1,
    kind: "migration",
    agentId,
    networkId: c.networkId,
    deviceId: c.deviceId,
    publicKey: c.publicKey,
    files,
  });
  await atomicJson(join(target, "migration.json"), receipt);
  return {
    target,
    retired: true,
    next: "Transfer migration.json to Hub; run agent migrate --receipt FILE --out INVITE. Transfer the full bundle to the new node and join with --seed DIR.",
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
  const agent = c.agents.find((a) => a.id === m.agentId),
    peer = c.peers.find((p) => p.deviceId === m.deviceId);
  requireThat(
    m.kind === "migration" &&
      m.version === 1 &&
      m.networkId === c.networkId &&
      agent?.role === "member" &&
      agent.deviceId === m.deviceId &&
      (m.deviceId === c.deviceId
        ? c.publicKey === m.publicKey
        : peer?.publicKey === m.publicKey && !peer.revoked),
    "INVALID_MIGRATION",
    "Migration does not match the registered writer.",
  );
  requireThat(
    confirmedId === m.agentId,
    "CONFIRMATION_REQUIRED",
    "Confirmation must match the migrating Agent.",
  );
  if (!agent.active && agent.seedHash === sha(JSON.stringify(m.files)))
    return invite(home, c, agent.id, out);
  await retire(home, c, agent.id);
  agent.seedHash = sha(JSON.stringify(m.files));
  await save(home, c);
  return invite(home, c, agent.id, out);
}
