import { join } from "node:path";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import {
  Config,
  Envelope,
  atomicJson,
  signed,
  verified,
  sha,
  validId,
  requireThat,
  save,
  registrationPath,
} from "./core.js";
import { reconcile } from "./sync.js";

interface Request {
  version: 1;
  networkId: string;
  deviceId: string;
  sources: { id: string; active: boolean }[];
}
interface Decision {
  version: 1;
  networkId: string;
  deviceId: string;
  requestHash: string;
  sources: { id: string; accepted: boolean; error?: string }[];
}
async function document<T>(path: string): Promise<Envelope<T> | undefined> {
  let file;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = await file.stat();
    requireThat(
      info.isFile() && info.size < 1024 * 1024,
      "INVALID_REGISTRATION",
      "Registration must be a regular document smaller than 1 MiB.",
    );
    return JSON.parse(await file.readFile("utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  } finally {
    await file?.close();
  }
}
async function publish<T>(home: string, path: string, payload: T) {
  const old = await document<T>(path);
  if (old && JSON.stringify(old.payload) === JSON.stringify(payload)) return;
  await atomicJson(path, await signed(home, payload));
}

// Authentication is pinned by machine enrollment. Each device has separate
// request/reply folders, so one peer cannot submit another peer's manifest.
export async function registerSources(c: Config, home: string): Promise<void> {
  if (c.mode === "node") {
    const request: Request = {
      version: 1,
      networkId: c.networkId,
      deviceId: c.deviceId,
      sources: c.agents
        .filter((a) => a.local && a.role === "member")
        .map((a) => ({ id: a.id, active: a.active }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    };
    await publish(
      home,
      join(registrationPath(c, c.deviceId, "requests"), "sources.json"),
      request,
    );
    const reply = await document<Decision>(
      join(registrationPath(c, c.deviceId, "replies"), "sources.json"),
    );
    if (!reply) return;
    const hub = c.peers.find((p) => p.deviceId === c.hubDeviceId && !p.revoked);
    requireThat(hub, "UNKNOWN_HUB", "Hub signing key is unavailable.");
    const decision = verified(reply, hub.publicKey);
    requireThat(
      decision.version === 1 &&
        decision.networkId === c.networkId &&
        decision.deviceId === c.deviceId &&
        Array.isArray(decision.sources),
      "INVALID_REGISTRATION",
      "Registration response belongs to another node or network.",
    );
    if (decision.requestHash !== sha(JSON.stringify(request))) return;
    let changed = false;
    for (const a of c.agents.filter((a) => a.local && a.role === "member")) {
      const result = decision.sources.find((s) => s.id === a.id);
      if (!result) continue;
      const state = result.accepted ? "registered" : "conflict";
      if (a.registration !== state || a.registrationError !== result.error) {
        a.registration = state;
        a.registrationError = result.error;
        changed = true;
      }
    }
    if (changed) {
      // Keep the persisted request pending until its folders are configured,
      // so the same reply is retried after a transient disk/API failure.
      await reconcile(c);
      await save(home, c);
    }
    return;
  }
  const errors: string[] = [];
  for (const peer of c.peers.filter((p) => !p.revoked)) {
    try {
      const incoming = await document<Request>(
        join(registrationPath(c, peer.deviceId, "requests"), "sources.json"),
      );
      if (!incoming) continue;
      const request = verified(incoming, peer.publicKey);
      requireThat(
        request.version === 1 &&
          request.networkId === c.networkId &&
          request.deviceId === peer.deviceId &&
          Array.isArray(request.sources) &&
          request.sources.length <= 1000,
        "INVALID_REGISTRATION",
        "Invalid node source manifest.",
      );
      const ids = new Set<string>();
      for (const item of request.sources) {
        validId(item.id);
        requireThat(
          typeof item.active === "boolean" && !ids.has(item.id),
          "INVALID_REGISTRATION",
          "Invalid or duplicate source entry.",
        );
        ids.add(item.id);
      }
      let changed = false;
      const sources: Decision["sources"] = [];
      for (const item of request.sources) {
        const old = c.agents.find((a) => a.id === item.id);
        if (
          old &&
          (old.deviceId !== peer.deviceId ||
            old.local ||
            (!old.active && item.active))
        ) {
          sources.push({
            id: item.id,
            accepted: false,
            error: "WRITER_CONFLICT",
          });
          continue;
        }
        if (!old) {
          c.agents.push({
            id: item.id,
            role: "member",
            deviceId: peer.deviceId,
            local: false,
            active: item.active,
            registration: "registered",
          });
          changed = true;
        } else if (old.active !== item.active) {
          old.active = item.active;
          changed = true;
        }
        sources.push({ id: item.id, accepted: true });
      }
      if (changed) await save(home, c);
      // Reconcile before publishing acceptance, including after interrupted runs.
      const replyPath = join(
        registrationPath(c, peer.deviceId, "replies"),
        "sources.json",
      );
      const response: Decision = {
        version: 1,
        networkId: c.networkId,
        deviceId: peer.deviceId,
        requestHash: sha(JSON.stringify(request)),
        sources,
      };
      const existing = await document<Decision>(replyPath);
      if (
        changed ||
        JSON.stringify(existing?.payload) !== JSON.stringify(response)
      ) {
        await reconcile(c);
        await publish(home, replyPath, response);
      }
    } catch (e) {
      errors.push(`${peer.deviceId}: ${(e as Error).message}`);
    }
  }
  requireThat(!errors.length, "REGISTRATION_FAILED", errors.join("; "));
}
