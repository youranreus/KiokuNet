import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  copyFile,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const script = resolve("scripts/release.mjs");
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
async function fixture() {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "kioku-release-test-")),
  );
  const root = join(dir, "checkout"),
    remote = join(dir, "remote.git"),
    bin = join(dir, "bin"),
    state = join(dir, "github.json"),
    log = join(dir, "commands.jsonl");
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(bin);
  await copyFile(script, join(root, "scripts/release.mjs"));
  await writeFile(join(root, ".gitignore"), ".release/\ndist/\n");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "kiokunet", version: "0.1.0" }),
  );
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify({
      version: "0.1.0",
      packages: { "": { version: "0.1.0" } },
    }),
  );
  await writeFile(state, JSON.stringify({ release: null, blobs: {} }));
  // Git itself is real. Only its SSH transport is redirected to a temporary bare repository.
  const ssh = join(bin, "ssh-test");
  await writeFile(
    ssh,
    `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const args=process.argv.slice(2);const receive=args.at(-1).startsWith('git-receive-pack');const r=spawnSync(receive?'git-receive-pack':'git-upload-pack',[process.env.TEST_REMOTE],{stdio:'inherit'});process.exit(r.status??1);\n`,
    { mode: 0o755 },
  );
  // These are the external npm/GitHub boundaries, with persistent state for retry scenarios.
  const fake = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const name=path.basename(process.argv[1]),a=process.argv.slice(2);
fs.appendFileSync(process.env.TEST_LOG,JSON.stringify({name,args:a})+'\\n');
if(name==='npm'){
 if(a[0]==='pack') {const filename='kiokunet-0.1.0.tgz';fs.writeFileSync(path.join(a[a.indexOf('--pack-destination')+1],filename),'compiled fixture package');console.log(JSON.stringify([{filename}]));}
 process.exit(0);
}
let s=JSON.parse(fs.readFileSync(process.env.TEST_STATE));
const save=()=>fs.writeFileSync(process.env.TEST_STATE,JSON.stringify(s));
if(a[0]==='auth'||a[0]==='repo'){console.log('{}');process.exit(0);}
if(a[0]==='api'){
 if(s.apiFailure){console.error('gh: unavailable (HTTP 503)');process.exit(1);}
 if(a.some(x=>x.endsWith('/releases?per_page=100'))){console.log(JSON.stringify([s.release?[s.release]:[]]));process.exit(0);}
 if(!s.release||(s.hideDraftByTag&&s.release.draft)){console.error('gh: Not Found (HTTP 404)');process.exit(1);}
 console.log(JSON.stringify(s.release));process.exit(0);
}
if(a[1]==='create'){
 if(s.release){console.error('exists');process.exit(1);}
 s.release={tag_name:'v0.1.0',draft:a.includes('--draft'),prerelease:a.includes('--prerelease'),assets:[],html_url:'https://github.com/test/kiokunet/releases/tag/v0.1.0'};save();process.exit(0);
}
if(a[1]==='upload'){
 for(const f of a.slice(3,a.indexOf('--repo'))){
  const n=path.basename(f);if(s.blobs[n])throw Error('Unexpected asset overwrite');
  s.blobs[n]=fs.readFileSync(f).toString('base64');s.release.assets.push({name:n,state:'uploaded'});save();
  if(s.failUploadOnce){s.failUploadOnce=false;save();console.error('interrupted upload');process.exit(1);}
 }process.exit(0);
}
if(a[1]==='download'){
 const n=a[a.indexOf('--pattern')+1];fs.writeFileSync(path.join(a[a.indexOf('--dir')+1],n),Buffer.from(s.blobs[n],'base64'));process.exit(0);
}
if(a[1]==='edit'){s.release.draft=false;save();process.exit(0);}
throw Error('Unexpected command: '+a.join(' '));
`;
  for (const name of ["npm", "gh"])
    await writeFile(join(bin, name), fake, { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GIT_SSH: ssh,
    GIT_SSH_VARIANT: "ssh",
    TEST_REMOTE: remote,
    TEST_LOG: log,
    TEST_STATE: state,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Release test",
    GIT_AUTHOR_EMAIL: "release@example.invalid",
    GIT_COMMITTER_NAME: "Release test",
    GIT_COMMITTER_EMAIL: "release@example.invalid",
  };
  const git = (...args) =>
    execFileSync(realGit, args, {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--bare", remote);
  git("init", "-b", "master");
  git("add", ".");
  git("commit", "-m", "fixture");
  git("remote", "add", "origin", "git@github.com:test/kiokunet.git");
  git("push", "origin", "master");
  return {
    root,
    remote,
    state,
    log,
    git,
    run: (...args) =>
      spawnSync(
        process.execPath,
        [join(root, "scripts/release.mjs"), ...args],
        { cwd: root, env, encoding: "utf8", timeout: 30000 },
      ),
    read: async () => JSON.parse(await readFile(state, "utf8")),
    update: async (extra) =>
      writeFile(
        state,
        JSON.stringify({
          ...JSON.parse(await readFile(state, "utf8")),
          ...extra,
        }),
      ),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("release dry-run leaves local/remote tags and GitHub untouched, and rejects dirty input", async () => {
  const f = await fixture();
  try {
    const r = f.run("--dry-run");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).tag, "v0.1.0");
    assert.equal(f.git("tag", "--list"), "");
    assert.equal(f.git("ls-remote", "--tags", "origin"), "");
    await assert.rejects(readFile(f.log), { code: "ENOENT" });
    await writeFile(join(f.root, "uncommitted.txt"), "work");
    const dirty = f.run("--dry-run");
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /Working tree must be clean/);
  } finally {
    await f.cleanup();
  }
});

test("release creates an annotated tag and verified assets; retries preserve published bytes", async () => {
  const f = await fixture();
  try {
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.git("cat-file", "-t", "v0.1.0"), "tag");
    assert.match(
      f.git("ls-remote", "origin", "refs/tags/v0.1.0^{}"),
      new RegExp(f.git("rev-parse", "HEAD")),
    );
    const first = await f.read();
    assert.equal(first.release.draft, false);
    const bytes = Buffer.from(first.blobs["kiokunet-0.1.0.tgz"], "base64");
    assert.equal(
      Buffer.from(first.blobs.SHA256SUMS, "base64").toString(),
      `${createHash("sha256").update(bytes).digest("hex")}  kiokunet-0.1.0.tgz\n`,
    );
    assert.equal(f.run().status, 0);
    assert.deepEqual((await f.read()).blobs, first.blobs);
    const s = await f.read();
    s.blobs["kiokunet-0.1.0.tgz"] = Buffer.from("tampered").toString("base64");
    await f.update(s);
    const conflict = f.run();
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /will not be overwritten/);
    assert.equal(
      (await f.read()).blobs["kiokunet-0.1.0.tgz"],
      s.blobs["kiokunet-0.1.0.tgz"],
    );
  } finally {
    await f.cleanup();
  }
});

test("interrupted upload stays a draft; rerun completes only missing assets and can publish later", async () => {
  const f = await fixture();
  try {
    await f.update({ failUploadOnce: true });
    assert.equal(f.run().status, 1);
    assert.equal((await f.read()).release.draft, true);
    assert.equal((await f.read()).release.assets.length, 1);
    const resumed = f.run("--draft");
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal((await f.read()).release.draft, true);
    assert.equal((await f.read()).release.assets.length, 2);
    assert.equal(f.run().status, 0);
    assert.equal((await f.read()).release.draft, false);
  } finally {
    await f.cleanup();
  }
});

test("different local or remote tag targets cannot be moved by release", async () => {
  const f = await fixture();
  try {
    const old = f.git("rev-parse", "HEAD");
    f.git("tag", "-a", "v0.1.0", "-m", "old release");
    f.git("push", "origin", "refs/tags/v0.1.0");
    f.git("commit", "--allow-empty", "-m", "next commit");
    f.git("push", "origin", "master");
    assert.match(f.run().stderr, /Local v0.1.0 points to a different commit/);
    f.git("tag", "-d", "v0.1.0");
    assert.match(f.run().stderr, /Remote v0.1.0 points to a different commit/);
    assert.match(
      f.git("ls-remote", "origin", "refs/tags/v0.1.0^{}"),
      new RegExp(old),
    );
    assert.equal((await f.read()).release, null);
  } finally {
    await f.cleanup();
  }
});

test("an API outage is not treated as a missing release and does not push a tag", async () => {
  const f = await fixture();
  try {
    await f.update({ apiFailure: true });
    const r = f.run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Cannot inspect GitHub release/);
    assert.equal(f.git("tag", "--list"), "");
    assert.equal(f.git("ls-remote", "--tags", "origin"), "");
  } finally {
    await f.cleanup();
  }
});

test("release refuses multiple push destinations before creating tags", async () => {
  const f = await fixture();
  try {
    f.git(
      "remote",
      "set-url",
      "--add",
      "--push",
      "origin",
      "git@github.com:test/kiokunet.git",
    );
    f.git(
      "remote",
      "set-url",
      "--add",
      "--push",
      "origin",
      "git@github.com:test/another.git",
    );
    const r = f.run("--dry-run");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /exactly one push URL/);
    assert.equal(f.git("tag", "--list"), "");
  } finally {
    await f.cleanup();
  }
});

test("drafts omitted by the tag endpoint are found through the release list", async () => {
  const f = await fixture();
  try {
    await f.update({ hideDraftByTag: true });
    const draft = f.run("--draft");
    assert.equal(draft.status, 0, draft.stderr);
    assert.equal((await f.read()).release.assets.length, 2);
    assert.equal((await f.read()).release.draft, true);
    const published = f.run();
    assert.equal(published.status, 0, published.stderr);
    assert.equal((await f.read()).release.draft, false);
  } finally {
    await f.cleanup();
  }
});
