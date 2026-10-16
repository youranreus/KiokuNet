#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registry = "https://registry.npmjs.org/";
const packageName = "@reus-able/kioku-net";
// Scope-specific npm configuration takes precedence over the default registry.
const registryArgs = [
  "--registry",
  registry,
  `--@reus-able:registry=${registry}`,
];
const help = `Usage: npm run release -- [--dry-run] [--draft] [--notes FILE]

Release the committed package.json version from a clean master branch.
Requires master to match origin/master, Node >=22.20, npm, git and authenticated gh.
Creates/reuses vVERSION at HEAD, pushes only that tag, uploads the npm tarball
and SHA256SUMS to a draft, verifies downloads, publishes the same tarball to npm,
then publishes GitHub unless --draft. Stable versions use latest; prereleases use next.
Existing tags/assets are never overwritten. Rerun after a partial failure.

--dry-run  Read-only Git preflight and plan; no build, registry access or writes.
--draft    Upload and verify GitHub assets; do not access or publish to npm.
--notes    UTF-8 release notes file; otherwise generate notes with install steps.

Bump first: npm run release:version -- patch (or minor, major, explicit version).
Review, commit and push version changes before running this script.
`;
function check(condition, message) {
  if (!condition) throw new Error(message);
}
function command(file, args, { allowFailure = false, visible = false } = {}) {
  const r = spawnSync(file, args, {
    cwd: root,
    encoding: "utf8",
    stdio: visible ? "inherit" : "pipe",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_HOST: "github.com" },
  });
  if (r.error) throw r.error;
  if (!allowFailure)
    check(
      r.status === 0,
      `${file} ${args.join(" ")} failed${r.stderr ? `: ${r.stderr.trim()}` : ""}`,
    );
  return { ...r, stdout: r.stdout || "", stderr: r.stderr || "" };
}
const git = (...args) => command("git", args).stdout.trim();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;
function repository(url) {
  const match =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
      url,
    );
  check(match, "origin must be a GitHub SSH or HTTPS repository URL.");
  return match[1];
}
function localTag(tag) {
  const r = command(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`],
    { allowFailure: true },
  );
  check(
    r.status === 0 || r.status === 1,
    r.stderr || "Unable to inspect local tag.",
  );
  return r.status === 0 ? git("rev-parse", `${tag}^{commit}`) : undefined;
}
function remoteState(tag) {
  const refs = new Map(
    git(
      "ls-remote",
      "origin",
      "refs/heads/master",
      `refs/tags/${tag}`,
      `refs/tags/${tag}^{}`,
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, ref] = line.split(/\s+/);
        return [ref, sha];
      }),
  );
  return {
    master: refs.get("refs/heads/master"),
    tag: refs.get(`refs/tags/${tag}^{}`) || refs.get(`refs/tags/${tag}`),
  };
}
function sourceState(head) {
  check(
    git("branch", "--show-current") === "master",
    "Release must run from master.",
  );
  check(
    !git("status", "--porcelain"),
    "Working tree must be clean, including untracked files. Commit changes first.",
  );
  check(
    git("rev-parse", "HEAD") === head,
    "HEAD changed during release; start again.",
  );
}
function tagState(tag, head) {
  const local = localTag(tag),
    remote = remoteState(tag);
  check(
    !local || local === head,
    `Local ${tag} points to a different commit; choose a new version. Tags are never moved.`,
  );
  check(
    !remote.tag || remote.tag === head,
    `Remote ${tag} points to a different commit; choose a new version. Tags are never moved.`,
  );
  check(
    remote.master === head,
    "HEAD must equal origin/master. Push master (or reconcile it) before releasing.",
  );
  return { local, remote };
}
function readRelease(repo, tag) {
  const r = command("gh", ["api", `repos/${repo}/releases/tags/${tag}`], {
    allowFailure: true,
  });
  if (r.status === 0) return JSON.parse(r.stdout);
  check(
    /\(HTTP 404\)/.test(r.stderr),
    `Cannot inspect GitHub release: ${r.stderr || r.stdout}`,
  );
  // GitHub may omit drafts from the by-tag endpoint even for their author.
  // The authenticated release list includes drafts and supports retrying uploads.
  const pages = JSON.parse(
    command("gh", [
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo}/releases?per_page=100`,
    ]).stdout,
  );
  return pages.flat().find((release) => release.tag_name === tag);
}
function readNpmVersion(spec) {
  const r = command(
    "npm",
    ["view", spec, "--json", ...registryArgs, "--prefer-online"],
    { allowFailure: true },
  );
  let metadata;
  try {
    metadata = JSON.parse(r.stdout);
  } catch {
    throw new Error(
      `Cannot inspect npm version ${spec}: ${r.stderr || r.stdout}`,
    );
  }
  if (r.status !== 0 && metadata?.error?.code === "E404") return undefined;
  check(
    r.status === 0 && metadata && !metadata.error,
    `Cannot inspect npm version ${spec}: ${r.stderr || r.stdout}`,
  );
  check(
    `${metadata.name}@${metadata.version}` === spec && metadata.dist?.integrity,
    `Invalid npm metadata for ${spec}; expected an exact version with integrity.`,
  );
  return metadata;
}
function verifyNpmVersion(metadata, integrity) {
  check(
    metadata.dist.integrity === integrity,
    "Existing npm package differs from this build. It will not be overwritten; choose a new version.",
  );
}
function publishNpm(spec, packageFile, integrity, npmTag) {
  // Re-read immediately before publication, including when resuming a partial release.
  let metadata = readNpmVersion(spec);
  if (!metadata) {
    command(
      "npm",
      [
        "publish",
        packageFile,
        ...registryArgs,
        "--access",
        "public",
        "--tag",
        npmTag,
        "--ignore-scripts",
        "--dry-run=false",
      ],
      // Inherit the terminal for npm's interactive authentication / 2FA challenge.
      { visible: true },
    );
    metadata = readNpmVersion(spec);
    check(
      metadata,
      "Unable to confirm npm publication. Rerun to inspect/resume.",
    );
  }
  verifyNpmVersion(metadata, integrity);
  console.log(`npm verified: ${spec} (${registry})`);
}
async function verifyAssets(repo, tag, release, files, requireAll) {
  const directory = await mkdtemp(join(tmpdir(), "kioku-release-verify-"));
  const missing = [];
  try {
    for (const file of files) {
      const assets = release.assets.filter((a) => a.name === file.name);
      check(assets.length <= 1, `Duplicate release asset: ${file.name}`);
      if (!assets.length) {
        missing.push(file);
        continue;
      }
      check(
        assets[0].state === "uploaded",
        `Asset ${file.name} is incomplete. Inspect the draft before retrying.`,
      );
      command("gh", [
        "release",
        "download",
        tag,
        "--repo",
        repo,
        "--pattern",
        file.name,
        "--dir",
        directory,
      ]);
      check(
        hash(await readFile(join(directory, file.name))) === file.hash,
        `Existing asset ${file.name} differs from this build. It will not be overwritten; inspect it or release a new version.`,
      );
    }
    check(
      !requireAll || missing.length === 0,
      "Release is missing required assets; it was not published.",
    );
    return missing;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const { values: opts } = parseArgs({
    options: {
      "dry-run": { type: "boolean" },
      draft: { type: "boolean" },
      notes: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (opts.help) {
    console.log(help);
    return;
  }
  const [major, minor] = process.versions.node.split(".").map(Number);
  check(
    major > 22 || (major === 22 && minor >= 20),
    "Node.js >=22.20 is required.",
  );
  check(
    resolve(git("rev-parse", "--show-toplevel")) === root,
    "Run from the KiokuNet repository checkout.",
  );
  const head = git("rev-parse", "HEAD");
  sourceState(head);
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(
    await readFile(join(root, "package-lock.json"), "utf8"),
  );
  check(
    pkg.name === packageName && semver.test(pkg.version),
    `Expected package ${packageName} with a valid version (no build metadata).`,
  );
  check(
    lock.version === pkg.version &&
      lock.packages?.[""]?.version === pkg.version,
    "package.json and package-lock.json versions must match.",
  );
  const tag = `v${pkg.version}`,
    prerelease = pkg.version.includes("-");
  const npmSpec = `${pkg.name}@${pkg.version}`,
    npmTag = prerelease ? "next" : "latest";
  const packageFilename = `${pkg.name.slice(1).replace("/", "-")}-${pkg.version}.tgz`;
  check(pkg.private !== true, "Cannot release a private npm package.");
  check(
    !pkg.publishConfig ||
      (pkg.publishConfig.registry === registry &&
        pkg.publishConfig.access === "public" &&
        pkg.publishConfig.tag === undefined),
    "publishConfig must use the public npm registry/access without a fixed tag.",
  );
  const fetchRepo = repository(git("remote", "get-url", "origin"));
  const pushUrls = git("remote", "get-url", "--all", "--push", "origin").split(
    "\n",
  );
  check(pushUrls.length === 1, "origin must have exactly one push URL.");
  const repo = repository(pushUrls[0]);
  check(
    repo.toLowerCase() === fetchRepo.toLowerCase(),
    "origin fetch and push must identify the same GitHub repository.",
  );
  const notes = opts.notes
    ? await readFile(resolve(opts.notes), "utf8")
    : undefined;
  const state = tagState(tag, head);
  console.log(
    JSON.stringify(
      {
        repository: repo,
        branch: "master",
        commit: head,
        version: pkg.version,
        tag,
        localTag: state.local ? "reuse" : "create",
        remoteTag: state.remote.tag ? "reuse" : "push",
        release: opts.draft ? "draft" : prerelease ? "prerelease" : "public",
        assets: [packageFilename, "SHA256SUMS"],
        npm: { registry, package: npmSpec, tag: npmTag, publish: !opts.draft },
        dryRun: Boolean(opts["dry-run"]),
      },
      null,
      2,
    ),
  );
  if (opts["dry-run"]) return;

  const lockPath = resolve(
    root,
    git("rev-parse", "--git-path", "kiokunet-release.lock"),
  );
  await mkdir(lockPath).catch((e) => {
    if (e.code === "EEXIST")
      throw new Error(
        `Release lock exists: ${lockPath}. Check for a running release before removing a stale lock.`,
      );
    throw e;
  });
  try {
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({ pid: process.pid, tag, head }),
    );
    command("gh", ["auth", "status", "--hostname", "github.com"]);
    command("gh", ["repo", "view", repo, "--json", "nameWithOwner"]);
    let release = readRelease(repo, tag);
    check(
      !release || release.prerelease === prerelease,
      "Existing release prerelease status differs from the package version.",
    );
    const npmVersion = opts.draft ? undefined : readNpmVersion(npmSpec);
    if (!opts.draft && !npmVersion)
      command("npm", ["whoami", "--registry", registry]);

    const output = join(root, ".release", tag, head);
    await mkdir(output, { recursive: true });
    // dist is generated; clear it so renamed/deleted modules cannot leak into the package.
    await rm(join(root, "dist"), { recursive: true, force: true });
    for (const script of [
      "typecheck",
      "format:check",
      "test",
      "test:prepare",
      "test:integration",
    ])
      command("npm", ["run", script], { visible: true });
    const packed = JSON.parse(
      command("npm", ["pack", "--json", "--pack-destination", output]).stdout,
    );
    check(
      packed.length === 1 && packed[0].filename === packageFilename,
      "Unexpected package output.",
    );
    const packageFile = join(output, packed[0].filename);
    const packageBytes = await readFile(packageFile);
    const integrity = `sha512-${createHash("sha512").update(packageBytes).digest("base64")}`;
    if (npmVersion) verifyNpmVersion(npmVersion, integrity);
    const checksum = `${hash(packageBytes)}  ${packed[0].filename}\n`;
    await writeFile(join(output, "SHA256SUMS"), checksum);
    const files = await Promise.all(
      [packed[0].filename, "SHA256SUMS"].map(async (name) => ({
        name,
        path: join(output, name),
        hash: hash(await readFile(join(output, name))),
      })),
    );
    const notesFile = join(output, "release-notes.md");
    await writeFile(
      notesFile,
      notes ??
        `Commit: ${head}\n\nRequires Node.js >=22.20. After publication, install from npm:\n\n\`\`\`bash\nnpm install -g ${npmSpec}\nkioku --help\n\`\`\`\n\nAlternatively, download the attached ${packageFilename} and SHA256SUMS, then run:\n\n\`\`\`bash\nsha256sum -c SHA256SUMS\nnpm install -g ./${packageFilename}\nkioku --help\n\`\`\`\n\nOn macOS, use \`shasum -a 256 -c SHA256SUMS\`. Use the attached npm package; GitHub source archives do not contain the compiled CLI.\n`,
    );
    sourceState(head);
    const current = tagState(tag, head);
    if (!current.local) {
      if (current.remote.tag)
        git("fetch", "origin", `refs/tags/${tag}:refs/tags/${tag}`);
      else git("tag", "-a", tag, "-m", `KiokuNet ${tag}`, head);
    }
    if (!current.remote.tag)
      git("push", "origin", `refs/tags/${tag}:refs/tags/${tag}`);
    check(remoteState(tag).tag === head, "Remote tag verification failed.");
    if (!release) {
      command("gh", [
        "release",
        "create",
        tag,
        "--repo",
        repo,
        "--verify-tag",
        "--draft",
        "--title",
        `KiokuNet ${tag}`,
        "--notes-file",
        notesFile,
        ...(notes === undefined ? ["--generate-notes"] : []),
        ...(prerelease ? ["--prerelease"] : []),
      ]);
      release = readRelease(repo, tag);
      check(
        release,
        "Draft creation did not return a readable release; rerun to inspect/resume.",
      );
    }
    const missing = await verifyAssets(
      repo,
      tag,
      release,
      files,
      !release.draft,
    );
    if (missing.length)
      command("gh", [
        "release",
        "upload",
        tag,
        ...missing.map((f) => f.path),
        "--repo",
        repo,
      ]);
    release = readRelease(repo, tag);
    check(release, "Release disappeared; rerun to inspect.");
    await verifyAssets(repo, tag, release, files, true);
    if (!opts.draft) publishNpm(npmSpec, packageFile, integrity, npmTag);
    if (release.draft && !opts.draft)
      command("gh", ["release", "edit", tag, "--repo", repo, "--draft=false"]);
    const final = readRelease(repo, tag);
    check(
      final && (opts.draft || !final.draft),
      "Unable to confirm publication. Rerun to inspect/resume.",
    );
    console.log(
      `${final.draft ? "Draft ready" : "Published"}: ${final.html_url}\nArtifacts: ${output}`,
    );
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(`Release failed: ${error.message}`);
  process.exitCode = 1;
});
