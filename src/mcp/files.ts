import { constants } from "node:fs";
import {
  lstat,
  realpath,
  open,
  readdir,
  opendir,
  mkdir,
  link,
  rename,
  rm,
  chmod,
} from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { Config, Failure, requireThat, sha } from "../core.js";
import { AccessGrant, McpSettings, settings } from "./config.js";

export function hidden(name: string) {
  // Keep controls inaccessible through case aliases on macOS filesystems.
  name = name.toLowerCase();
  return (
    [".stfolder", ".stversions", ".stignore", ".kioku-shared.json"].includes(
      name,
    ) ||
    name.startsWith(".syncthing.") ||
    name.endsWith(".kioku-tmp")
  );
}
type Root = {
  path: string;
  physical: string;
  space: string;
  writable: boolean;
};
export function roots(c: Config, key: AccessGrant): Root[] {
  const p = key.permissions;
  return [
    ...(p.shared === "none"
      ? []
      : [
          {
            path: "/shared",
            physical: "shared",
            space: "shared",
            writable: p.shared === "read-write",
          },
        ]),
    ...c.spaces
      .filter(
        (s) =>
          s.active &&
          s.registration !== "conflict" &&
          (p.readSpaces === "*" ||
            p.readSpaces.includes(s.id) ||
            p.writeSpaces.includes(s.id)),
      )
      .map((s) => ({
        path: `/spaces/${s.id}`,
        physical: `spaces/${s.id}`,
        space: s.id,
        writable:
          p.writeSpaces.includes(s.id) && s.local && s.deviceId === c.deviceId,
      })),
  ];
}
function validPath(path: string) {
  requireThat(
    typeof path === "string" &&
      path.startsWith("/") &&
      path.length <= 4096 &&
      !/[\\\x00-\x1f\x7f]/.test(path),
    "INVALID_PATH",
    "Use an absolute virtual knowledge path.",
  );
  requireThat(
    path === "/" ||
      path
        .slice(1)
        .split("/")
        .every((p) => p && p !== "." && p !== ".." && !hidden(p)),
    "INVALID_PATH",
    "Traversal, empty components and control files are not allowed.",
  );
}
export function fileError(error: unknown): Failure {
  if (error instanceof Failure) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  const known: Record<string, [string, string]> = {
    ENOENT: ["NOT_FOUND", "File or parent directory not found."],
    EEXIST: ["ALREADY_EXISTS", "The destination already exists."],
    ENOTDIR: ["NOT_DIRECTORY", "A path component is not a directory."],
    EISDIR: ["NOT_FILE", "Expected a regular file."],
    ELOOP: ["UNSAFE_PATH", "Symbolic links are not allowed."],
    EACCES: ["IO_DENIED", "The Hub cannot access this file."],
    EPERM: ["IO_DENIED", "The Hub cannot access this file."],
  };
  const entry = known[code || ""];
  return entry
    ? new Failure(...entry)
    : new Failure("IO_ERROR", "Knowledge file operation failed.");
}
const serial = new Map<string, Promise<void>>();
async function locked<T>(path: string, fn: () => Promise<T>) {
  const previous = serial.get(path) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((r) => {
    release = r;
  });
  serial.set(path, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (serial.get(path) === current) serial.delete(path);
  }
}
export class KnowledgeFiles {
  private limits: McpSettings;
  private visible: Root[];
  constructor(
    private c: Config,
    private key: AccessGrant,
    private reauthorize: () => Promise<void> = async () => {},
  ) {
    this.limits = settings(c);
    this.visible = roots(c, key);
  }
  private locate(path: string, write = false) {
    validPath(path);
    const root = this.visible.find(
      (r) => path === r.path || path.startsWith(r.path + "/"),
    );
    requireThat(
      root && (!write || root.writable),
      "FORBIDDEN",
      "This connection cannot access the requested path for this operation.",
    );
    return {
      root,
      relative: path.slice(root.path.length),
      full: join(this.c.root, root.physical, path.slice(root.path.length)),
    };
  }
  // Local filesystem owners remain trusted. Revalidate before publication;
  // Node does not expose openat-style traversal against hostile local renames.
  private async checked(path: string, write = false, missing = false) {
    const target = this.locate(path, write);
    requireThat(
      (await realpath(this.c.root)) === this.c.root,
      "UNSAFE_PATH",
      "The knowledge root has changed.",
    );
    const parts = (target.root.physical + target.relative).split("/");
    let current = this.c.root;
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]!);
      let s;
      try {
        s = await lstat(current);
      } catch (e) {
        if (
          missing &&
          i === parts.length - 1 &&
          (e as NodeJS.ErrnoException).code === "ENOENT"
        )
          return target;
        throw e;
      }
      requireThat(
        !s.isSymbolicLink() &&
          (s.isDirectory() || s.isFile()) &&
          (!s.isFile() || s.nlink === 1),
        "UNSAFE_PATH",
        "Links and special files are not available through MCP.",
      );
      if (i < parts.length - 1 || !target.relative)
        requireThat(
          s.isDirectory(),
          "NOT_DIRECTORY",
          "A path component is not a directory.",
        );
    }
    return target;
  }
  private async bytes(path: string) {
    const target = await this.checked(path);
    const file = await open(
      target.full,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      requireThat(
        stat.isFile() && stat.nlink === 1,
        "UNSAFE_PATH",
        "Expected a regular file with a single link.",
      );
      requireThat(
        stat.size <= this.limits.maxFileBytes,
        "FILE_TOO_LARGE",
        "File exceeds the configured text size limit.",
      );
      const buffer = Buffer.alloc(stat.size + 1);
      let count = 0;
      while (count < buffer.length) {
        const r = await file.read(buffer, count, buffer.length - count, null);
        if (!r.bytesRead) break;
        count += r.bytesRead;
      }
      requireThat(
        count <= this.limits.maxFileBytes,
        "FILE_TOO_LARGE",
        "File exceeds the configured text size limit.",
      );
      const after = await file.stat();
      requireThat(
        count === stat.size &&
          stat.size === after.size &&
          stat.mtimeMs === after.mtimeMs &&
          stat.ctimeMs === after.ctimeMs,
        "FILE_CHANGED",
        "File changed while reading; retry.",
      );
      return { buffer: buffer.subarray(0, count), mode: stat.mode & 0o777 };
    } finally {
      await file.close();
    }
  }
  private decode(buffer: Buffer) {
    let content: string;
    try {
      content = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(buffer);
    } catch {
      throw new Failure("NOT_UTF8_TEXT", "File is not UTF-8 text.");
    }
    requireThat(
      !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content),
      "NOT_UTF8_TEXT",
      "Binary control characters are not supported.",
    );
    return content;
  }
  private encode(content: string) {
    const buffer = Buffer.from(content, "utf8");
    requireThat(
      buffer.length <= this.limits.maxFileBytes,
      "FILE_TOO_LARGE",
      "Content exceeds the configured text size limit.",
    );
    requireThat(
      this.decode(buffer) === content,
      "NOT_UTF8_TEXT",
      "Content contains invalid Unicode.",
    );
    return buffer;
  }
  async read(path: string) {
    const { buffer } = await this.bytes(path);
    return {
      path,
      content: this.decode(buffer),
      version: sha(buffer),
      bytes: buffer.length,
    };
  }
  async list(path = "/", cursor?: string) {
    validPath(path);
    let entries: {
      path: string;
      name: string;
      type: string;
      writable: boolean;
    }[] = [];
    if (path === "/") {
      entries = [
        ...(this.visible.some((r) => r.path.startsWith("/spaces/"))
          ? [
              {
                path: "/spaces",
                name: "spaces",
                type: "directory",
                writable: false,
              },
            ]
          : []),
        ...this.visible
          .filter((r) => r.path === "/shared")
          .map((r) => ({
            path: r.path,
            name: "shared",
            type: "directory",
            writable: r.writable,
          })),
      ];
    } else if (path === "/spaces") {
      entries = this.visible
        .filter((r) => r.path.startsWith("/spaces/"))
        .map((r) => ({
          path: r.path,
          name: r.space,
          type: "directory",
          writable: r.writable,
        }));
    } else {
      const target = await this.checked(path);
      for (const name of await readdir(target.full)) {
        if (hidden(name) || /[\\\x00-\x1f\x7f]/.test(name)) continue;
        const s = await lstat(join(target.full, name)).catch(() => undefined);
        if (
          !s ||
          s.isSymbolicLink() ||
          (!s.isDirectory() && !(s.isFile() && s.nlink === 1))
        )
          continue;
        entries.push({
          path: `${path}/${name}`,
          name,
          type: s.isDirectory() ? "directory" : "file",
          writable: target.root.writable,
        });
      }
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (cursor) entries = entries.filter((e) => e.name > cursor);
    const more = entries.length > this.limits.maxResults;
    entries = entries.slice(0, this.limits.maxResults);
    return {
      path,
      entries,
      ...(more ? { nextCursor: entries.at(-1)!.name } : {}),
    };
  }
  async createDirectory(path: string) {
    const target = this.locate(path, true);
    return locked(this.c.root, async () => {
      await this.reauthorize();
      // Do not manufacture missing source roots; they belong to local management.
      await this.checked(target.root.path, true);
      let prefix = target.root.path;
      for (const part of target.relative.split("/").filter(Boolean)) {
        await this.reauthorize();
        prefix += "/" + part;
        const current = await this.checked(prefix, true, true);
        try {
          await mkdir(current.full, { mode: 0o755 });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
        await this.checked(prefix, true);
        requireThat(
          (await lstat(current.full)).isDirectory(),
          "NOT_DIRECTORY",
          "The destination is not a directory.",
        );
      }
      return { path };
    });
  }
  async write(
    path: string,
    content: string | undefined,
    version?: string,
    edit?: { oldText: string; newText: string },
  ) {
    const target = this.locate(path, true);
    requireThat(
      target.relative,
      "NOT_FILE",
      "Cannot replace a knowledge root.",
    );
    // Root-wide serialization also covers case/Unicode aliases of a filename
    // on case-insensitive filesystems, and concurrent directory creation.
    return locked(this.c.root, async () => {
      await this.reauthorize();
      await this.checked(path, true, true);
      let mode = 0o644;
      if (version !== undefined) {
        const current = await this.bytes(path);
        requireThat(
          sha(current.buffer) === version,
          "VERSION_CONFLICT",
          "File changed; read it again before modifying it.",
        );
        const old = this.decode(current.buffer);
        mode = current.mode;
        if (edit) {
          const index = old.indexOf(edit.oldText);
          requireThat(
            edit.oldText.length > 0 &&
              index >= 0 &&
              old.indexOf(edit.oldText, index + 1) < 0,
            "EDIT_NOT_UNIQUE",
            "oldText must occur exactly once.",
          );
          content =
            old.slice(0, index) +
            edit.newText +
            old.slice(index + edit.oldText.length);
        }
      }
      requireThat(
        typeof content === "string",
        "INVALID_ARGUMENT",
        "Text content is required.",
      );
      const buffer = this.encode(content);
      const temporary = join(
        dirname(target.full),
        `.${randomUUID()}.kioku-tmp`,
      );
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(buffer);
          await file.sync();
        } finally {
          await file.close();
        }
        await chmod(temporary, mode);
        await this.reauthorize();
        await this.checked(path, true, true);
        if (version === undefined) await link(temporary, target.full);
        else {
          requireThat(
            sha((await this.bytes(path)).buffer) === version,
            "VERSION_CONFLICT",
            "File changed; read it again before modifying it.",
          );
          await rename(temporary, target.full);
        }
      } finally {
        await rm(temporary, { force: true });
      }
      return { path, version: sha(buffer), bytes: buffer.length };
    });
  }
  async search(
    kind: "name" | "content",
    args: {
      keywords: string[];
      path?: string;
      mode?: "any" | "all";
      caseSensitive?: boolean;
      matchPath?: boolean;
      limit?: number;
    },
    signal?: AbortSignal,
  ) {
    const {
      keywords,
      path = "/",
      mode = "any",
      caseSensitive = false,
      matchPath = false,
    } = args;
    requireThat(
      keywords.length > 0 &&
        keywords.length <= this.limits.maxKeywords &&
        keywords.every(
          (k) => k.length > 0 && k.length <= 1024 && !/[\r\n]/.test(k),
        ),
      "INVALID_KEYWORDS",
      "Supply nonempty single-line keywords within the configured limit (at most 1024 characters each).",
    );
    const limit = args.limit ?? this.limits.maxResults;
    requireThat(
      Number.isInteger(limit) && limit > 0 && limit <= this.limits.maxResults,
      "INVALID_LIMIT",
      "Result limit exceeds the configured maximum.",
    );
    validPath(path);
    if (path !== "/" && path !== "/spaces") this.locate(path);
    const scope =
      path === "/"
        ? this.visible.map((r) => r.path)
        : path === "/spaces"
          ? this.visible
              .filter((r) => r.path.startsWith("/spaces/"))
              .map((r) => r.path)
          : [path];
    const deadline = Date.now() + this.limits.searchTimeoutMs;
    const results: Record<string, unknown>[] = [];
    const skipped: { path: string; reason: string }[] = [];
    let skippedCount = 0,
      scannedFiles = 0,
      stopReason: string | undefined;
    const skip = (path: string, reason: string) => {
      skippedCount++;
      if (skipped.length < this.limits.maxResults)
        skipped.push({ path, reason });
    };
    const stop = () => {
      if (signal?.aborted) stopReason = "cancelled";
      else if (Date.now() >= deadline) stopReason = "timeout";
      return Boolean(stopReason);
    };
    const normalize = (s: string) => (caseSensitive ? s : s.toLowerCase());
    const needles = keywords.map(normalize);
    const matches = (text: string) => {
      const normalized = normalize(text);
      const found: string[] = [];
      for (let i = 0; i < keywords.length && !stop(); i++)
        if (normalized.includes(needles[i]!)) found.push(keywords[i]!);
      return found;
    };
    const accepted = (found: string[]) =>
      mode === "all" ? found.length === keywords.length : found.length > 0;
    const add = (value: Record<string, unknown>) => {
      if (results.length >= limit) {
        stopReason = "result_limit";
        return false;
      }
      results.push(value);
      return true;
    };
    const visitFile = async (path: string) => {
      const target = this.locate(path);
      scannedFiles++;
      if (kind === "name") {
        const found = matches(
          matchPath ? target.relative.slice(1) : basename(path),
        );
        if (accepted(found))
          add({ path, space: target.root.space, keywords: found });
      } else {
        let content: string;
        try {
          content = (await this.read(path)).content;
        } catch (e) {
          skip(path, fileError(e).code);
          return;
        }
        if (stop() || !accepted(matches(content))) return;
        const lines = content.split(/\r\n|\n|\r/);
        for (let i = 0; i < lines.length && !stop(); i++) {
          const line = lines[i]!,
            found = matches(line);
          if (!found.length) continue;
          const index = normalize(line).indexOf(normalize(found[0]!)),
            start = Math.max(0, index - 80);
          if (
            !add({
              path,
              space: target.root.space,
              line: i + 1,
              snippet: line.slice(start, start + 400),
              snippetTruncated: start > 0 || line.length > start + 400,
              keywords: found,
            })
          )
            break;
        }
      }
    };
    const pending = [...scope];
    while (pending.length && !stop()) {
      await setImmediate();
      const current = pending.pop()!;
      try {
        const target = await this.checked(current);
        const stat = await lstat(target.full);
        if (stat.isFile()) {
          await visitFile(current);
          continue;
        }
        const directory = await opendir(target.full);
        for await (const entry of directory) {
          if (stop()) break;
          if (hidden(entry.name)) continue;
          const child = current + "/" + entry.name;
          if (/[\\\x00-\x1f\x7f]/.test(entry.name)) {
            skip(current, "INVALID_PATH");
            continue;
          }
          if (entry.isDirectory()) pending.push(child);
          else if (entry.isFile()) {
            try {
              await this.checked(child);
              await visitFile(child);
            } catch (e) {
              skip(child, fileError(e).code);
            }
          } else skip(child, "UNSAFE_PATH");
        }
      } catch (e) {
        skip(current, fileError(e).code);
      }
    }
    return {
      results,
      scannedFiles,
      complete: !stopReason && skippedCount === 0,
      truncated: Boolean(stopReason),
      ...(stopReason ? { reason: stopReason } : {}),
      skipped,
      skippedCount,
      skippedTruncated: skippedCount > skipped.length,
    };
  }
}
