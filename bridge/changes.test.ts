import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  capDiff,
  changesParams,
  commitFileDiff,
  discoverRepos,
  fileDiff,
  GIT_TIMEOUT_MS,
  gitEnv,
  listChanges,
  MAX_DIFF_LINES,
  parseCommitObject,
  parseNameStatusZ,
  parseNumstatZ,
  parseStatusV2,
  readCommit,
  repoOfFolder,
  SharedReads,
  sharedDiffs,
  sharedFileDiff,
  sharedListChanges,
  sharedLists,
  gitRuns,
  CHANGES_SHARE_MS,
  syntheticAddedDiff,
} from "./changes.ts";
import type { ChangeCommit, ChangesList } from "./types.ts";

// Real git, in throwaway folders. The module's whole job is how it drives git, so a fake would
// test the fake.

let base: string;

/** gitEnv with transports allowed again, so fixtures can clone. The runner under test refuses them. */
function fixtureEnv(): Record<string, string> {
  const env = gitEnv(process.env);
  delete env.GIT_ALLOW_PROTOCOL;
  delete env.GIT_NO_LAZY_FETCH;
  delete env.GIT_PROTOCOL_FROM_USER;
  return env;
}

/** Plain git for building fixtures — NOT the hardened runner under test. */
function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args],
    { cwd, env: fixtureEnv(), stdout: "pipe", stderr: "pipe" },
  );
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString();
}

function write(path: string, content: string | Uint8Array) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

/** A repo with one committed file, `a.txt`. */
function repo(dir: string, files: Record<string, string> = { "a.txt": "one\ntwo\nthree\n" }): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  for (const [name, content] of Object.entries(files)) write(join(dir, name), content);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

const P = { depth: 2, nested: true };
const params = (repoRel: string | null, path: string | null, over: Partial<typeof P> = {}) => ({
  ...P,
  ...over,
  repo: repoRel,
  path,
});

function available(res: ChangesList) {
  if (!res.available) throw new Error(`unavailable: ${res.reason}`);
  return res;
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "collie-changes-"));
});
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("changesParams", () => {
  test("defaults, and clamps depth to 1..4", () => {
    const at = (q: string) => changesParams(new URL(`http://x/api/pane/p/changes${q}`));
    expect(at("")).toEqual({ depth: 2, nested: true, repo: null, path: null, view: "changes" });
    expect(at("?depth=0").depth).toBe(1);
    expect(at("?depth=99").depth).toBe(4);
    expect(at("?depth=abc").depth).toBe(2);
    expect(at("?nested=0").nested).toBe(false);
    expect(at("?nested=1").nested).toBe(true);
    expect(at("?repo=.&path=a%20b").path).toBe("a b");
    expect(at("").view).toBe("changes");
    expect(at("?view=commit&repo=.").view).toBe("commit");
    expect(at("?view=HEAD~3").view).toBe("changes");
  });
});

describe("parsers", () => {
  test("porcelain v2 keeps spaces in paths and reads renames", () => {
    const raw = [
      "1 .M N... 100644 100644 100644 abc abc a b.txt",
      "2 R. N... 100644 100644 100644 abc abc R100 new name.txt",
      "old name.txt",
      "1 A. N... 000000 100644 100644 000 abc added.txt",
      "1 AD N... 000000 100644 000000 000 abc gone-again.txt",
      "1 D. N... 100644 000000 000000 abc 000 deleted.txt",
      "? new dir/",
      "",
    ].join("\0");
    expect(parseStatusV2(raw)).toEqual([
      { path: "a b.txt", status: "M", submodule: false },
      { path: "new name.txt", oldPath: "old name.txt", status: "R", submodule: false },
      { path: "added.txt", status: "A", submodule: false },
      { path: "deleted.txt", status: "D", submodule: false },
      { path: "new dir/", status: "?", submodule: false },
    ]);
  });

  test("numstat -z reads renames and binary", () => {
    const raw = ["3\t1\ta.txt", "0\t0\t", "old.txt", "new.txt", "-\t-\timg.png", ""].join("\0");
    const m = parseNumstatZ(raw);
    expect(m.get("a.txt")).toEqual({ added: 3, removed: 1, binary: false });
    expect(m.get("new.txt")).toEqual({ added: 0, removed: 0, binary: false });
    expect(m.get("img.png")).toEqual({ added: 0, removed: 0, binary: true });
  });

  test("the synthetic diff marks a missing final newline", () => {
    expect(syntheticAddedDiff("x", "a\nb")).toContain("@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file\n");
  });

  test("capDiff cuts at a line boundary", () => {
    const text = Array.from({ length: MAX_DIFF_LINES + 10 }, (_, i) => `+${i}`).join("\n");
    const capped = capDiff(text);
    expect(capped.truncated).toBe(true);
    expect(capped.diff.split("\n").length - 1).toBe(MAX_DIFF_LINES);
    expect(capped.diff.endsWith("\n")).toBe(true);
  });
});

describe("list and diff", () => {
  test("a blank folder (zellij) answers no-folder", async () => {
    expect(await listChanges("", P)).toEqual({ available: false, reason: "no-folder" });
    expect(await fileDiff("", params(".", "a.txt"))).toMatchObject({ available: false, reason: "no-folder" });
  });

  test("lists modified, added, deleted, renamed and untracked files with counts", async () => {
    const dir = repo(join(base, "basic"), { "a.txt": "one\ntwo\nthree\n", "b.txt": "b\n", "c.txt": "c\n" });
    write(join(dir, "a.txt"), "one\nTWO\nthree\nfour\n");
    git(dir, "rm", "-q", "b.txt");
    git(dir, "mv", "c.txt", "c2.txt");
    write(join(dir, "new.txt"), "x\ny\n");
    git(dir, "add", "new.txt");
    write(join(dir, "loose.txt"), "1\n2\n3\n");
    const res = available(await listChanges(dir, P));
    expect(res.repos).toHaveLength(1);
    const [only] = res.repos;
    expect(only!.relPath).toBe(".");
    expect(only!.name).toBe("basic");
    const byPath = Object.fromEntries(only!.files.map((f) => [f.path, f]));
    expect(byPath["a.txt"]).toMatchObject({ status: "M", added: 2, removed: 1 });
    expect(byPath["b.txt"]).toMatchObject({ status: "D", removed: 1 });
    expect(byPath["c2.txt"]).toMatchObject({ status: "R", oldPath: "c.txt" });
    expect(byPath["new.txt"]).toMatchObject({ status: "A", added: 2 });
    expect(byPath["loose.txt"]).toMatchObject({ status: "?", added: 3 });

    const diff = await fileDiff(dir, params(".", "a.txt"));
    expect(diff).toMatchObject({ available: true, status: "M", binary: false, truncated: false });
    if (diff.available) expect(diff.diff).toContain("+TWO\n");

    const renamed = await fileDiff(dir, params(".", "c2.txt"));
    expect(renamed).toMatchObject({ available: true, status: "R", oldPath: "c.txt" });
    if (renamed.available) expect(renamed.diff).toContain("rename from c.txt");

    const loose = await fileDiff(dir, params(".", "loose.txt"));
    if (!loose.available) throw new Error("loose unavailable");
    expect(loose.diff).toContain("@@ -0,0 +1,3 @@\n+1\n+2\n+3\n");
  });

  test("a subfolder of a repo names the repo `..`", async () => {
    const dir = repo(join(base, "up"), { "sub/a.txt": "a\n" });
    write(join(dir, "sub/a.txt"), "b\n");
    const res = available(await listChanges(join(dir, "sub"), P));
    expect(res.repos.map((r) => r.relPath)).toEqual([".."]);
    expect(res.repos[0]!.files[0]!.path).toBe("sub/a.txt");
    expect(await fileDiff(join(dir, "sub"), params("..", "sub/a.txt"))).toMatchObject({ available: true });
  });

  test("refuses an unlisted path, a ../ path and an unknown repo", async () => {
    const dir = repo(join(base, "refuse"), { "a.txt": "a\n", "clean.txt": "clean\n" });
    write(join(dir, "a.txt"), "changed\n");
    write(join(base, "outside.txt"), "secret\n");
    expect(await fileDiff(dir, params(".", "clean.txt"))).toMatchObject({ reason: "unknown-path" });
    expect(await fileDiff(dir, params(".", "../outside.txt"))).toMatchObject({ reason: "unknown-path" });
    expect(await fileDiff(dir, params(".", "/etc/passwd"))).toMatchObject({ reason: "unknown-path" });
    expect(await fileDiff(dir, params("..", "outside.txt"))).toMatchObject({ reason: "unknown-repo" });
    expect(await fileDiff(dir, params("nope", "a.txt"))).toMatchObject({ reason: "unknown-repo" });
    expect(await fileDiff(dir, params(null, "a.txt"))).toMatchObject({ reason: "unknown-repo" });
  });

  test("an untracked symlink out of the repo is listed but never read", async () => {
    const dir = repo(join(base, "link"));
    write(join(base, "link-target.txt"), "secret\nsecret\n");
    symlinkSync(join(base, "link-target.txt"), join(dir, "leak"));
    symlinkSync("a.txt", join(dir, "inside"));
    const res = available(await listChanges(dir, P));
    const leak = res.repos[0]!.files.find((f) => f.path === "leak");
    expect(leak).toMatchObject({ status: "?", added: 0 });
    expect(await fileDiff(dir, params(".", "leak"))).toMatchObject({ available: false, reason: "unknown-path" });
    // A link that stays inside shows what git would show: the link's own text, not the file.
    const inside = await fileDiff(dir, params(".", "inside"));
    if (!inside.available) throw new Error("inside link refused");
    expect(inside.diff).toContain("+a.txt\n");
  });

  test("binary files carry no body", async () => {
    const dir = repo(join(base, "bin"), { "img.bin": "\0\x01\x02" });
    write(join(dir, "img.bin"), new Uint8Array([0, 1, 2, 3, 4]));
    write(join(dir, "new.bin"), new Uint8Array([9, 0, 9]));
    const res = available(await listChanges(dir, P));
    const files = Object.fromEntries(res.repos[0]!.files.map((f) => [f.path, f]));
    expect(files["img.bin"]).toMatchObject({ binary: true });
    expect(files["new.bin"]).toMatchObject({ binary: true, status: "?" });
    expect(await fileDiff(dir, params(".", "img.bin"))).toMatchObject({ binary: true, diff: "" });
    expect(await fileDiff(dir, params(".", "new.bin"))).toMatchObject({ binary: true, diff: "" });
  });

  test("a long diff is truncated", async () => {
    const dir = repo(join(base, "long"));
    write(join(dir, "a.txt"), Array.from({ length: 6000 }, (_, i) => `line ${i}`).join("\n") + "\n");
    write(join(dir, "big.txt"), Array.from({ length: 6000 }, (_, i) => `line ${i}`).join("\n") + "\n");
    for (const path of ["a.txt", "big.txt"]) {
      const res = await fileDiff(dir, params(".", path));
      if (!res.available) throw new Error(`${path} unavailable`);
      expect(res.truncated).toBe(true);
      expect(res.diff.split("\n").length - 1).toBeLessThanOrEqual(MAX_DIFF_LINES);
    }
  });

  test("a repo with no commits diffs against the empty tree", async () => {
    const dir = join(base, "fresh");
    mkdirSync(dir);
    git(dir, "init", "-q");
    write(join(dir, "staged.txt"), "s1\ns2\n");
    git(dir, "add", "staged.txt");
    write(join(dir, "loose.txt"), "l\n");
    const res = available(await listChanges(dir, P));
    const files = Object.fromEntries(res.repos[0]!.files.map((f) => [f.path, f]));
    expect(files["staged.txt"]).toMatchObject({ status: "A", added: 2 });
    expect(files["loose.txt"]).toMatchObject({ status: "?", added: 1 });
    const diff = await fileDiff(dir, params(".", "staged.txt"));
    if (!diff.available) throw new Error("staged unavailable");
    expect(diff.diff).toContain("+s1\n+s2\n");
  });

  test("an untracked folder is one entry and has no body", async () => {
    const dir = repo(join(base, "udir"));
    write(join(dir, "fresh/one.txt"), "1\n");
    write(join(dir, "fresh/two.txt"), "2\n");
    const res = available(await listChanges(dir, P));
    expect(res.repos[0]!.files.map((f) => f.path)).toEqual(["fresh/"]);
    expect(await fileDiff(dir, params(".", "fresh/"))).toMatchObject({ directory: true, diff: "" });
  });
});

describe("discovery", () => {
  test("finds a repo the parent gitignores, and the parent does not list it", async () => {
    const ws = repo(join(base, "ws"), { ".gitignore": "member/\n", "readme.md": "ws\n" });
    const member = repo(join(ws, "member"));
    write(join(member, "a.txt"), "member change\n");
    write(join(ws, "readme.md"), "ws change\n");
    const res = available(await listChanges(ws, P));
    expect(res.repos.map((r) => r.relPath).toSorted()).toEqual([".", "member"]);
    const parent = res.repos.find((r) => r.relPath === ".")!;
    expect(parent.files.map((f) => f.path)).toEqual(["readme.md"]);
    const diff = await fileDiff(ws, params("member", "a.txt"));
    expect(diff).toMatchObject({ available: true, repo: "member" });
  });

  test("a plain folder with repos below it works, and an untracked nested repo is shown once", async () => {
    const projects = join(base, "projects");
    mkdirSync(projects);
    const one = repo(join(projects, "one"));
    write(join(one, "a.txt"), "x\n");
    const res = available(await listChanges(projects, P));
    expect(res.repos.map((r) => r.relPath)).toEqual(["one"]);

    // Not ignored, not a submodule: the parent's status would say `? inner/`.
    const outer = repo(join(base, "outer"));
    const inner = repo(join(outer, "inner"));
    write(join(inner, "a.txt"), "y\n");
    const res2 = available(await listChanges(outer, P));
    expect(res2.repos.map((r) => r.relPath)).toEqual(["inner"]);
  });

  test("depth bounds the walk, and nested=false looks at the containing repo only", async () => {
    const top = join(base, "deep");
    mkdirSync(top);
    repo(join(top, "a/b/c"));
    const shallow = await discoverRepos(top, 2, true);
    expect(shallow.repos).toHaveLength(0);
    // A repo sits one level past the walk, so a deeper setting would find it.
    expect(shallow.depthLimited).toBe(true);
    // Two levels short is not flagged: the look-ahead reads one level, never the whole tree.
    expect((await discoverRepos(top, 1, true)).depthLimited).toBe(false);
    const deep = await discoverRepos(top, 3, true);
    expect(deep.repos.map((r) => r.relPath)).toEqual(["a/b/c"]);
    expect(deep.depthLimited).toBe(false);
    expect(available(await listChanges(top, { depth: 2, nested: true })).depthLimited).toBe(true);
    const ws = repo(join(base, "flat"));
    repo(join(ws, "child"));
    expect((await discoverRepos(ws, 2, false)).repos.map((r) => r.relPath)).toEqual(["."]);
    // The diff route uses the same discovery, so a nested repo is unknown with nested off.
    write(join(ws, "child/a.txt"), "z\n");
    expect(await fileDiff(ws, params("child", "a.txt", { nested: false }))).toMatchObject({
      reason: "unknown-repo",
    });
  });

  test("skips node_modules, dot-folders and symlinked folders", async () => {
    const top = join(base, "skips");
    mkdirSync(top);
    repo(join(top, "node_modules/pkg"));
    repo(join(top, ".hidden/r"));
    const real = repo(join(base, "elsewhere"));
    symlinkSync(real, join(top, "linked"));
    expect((await discoverRepos(top, 4, true)).repos).toHaveLength(0);
  });

  test("a submodule that discovery finds is shown once, as its own repo", async () => {
    const parent = repo(join(base, "super"));
    const child = repo(join(parent, "child"));
    const firstHead = git(child, "rev-parse", "HEAD").trim();
    git(parent, "update-index", "--add", "--cacheinfo", `160000,${firstHead},child`);
    git(parent, "commit", "-q", "-m", "gitlink");
    // Move the submodule on, so the parent's gitlink reads as modified, and leave a change inside it.
    write(join(child, "a.txt"), "moved\n");
    git(child, "commit", "-q", "-am", "move");
    write(join(child, "a.txt"), "dirty\n");
    const withChild = available(await listChanges(parent, P));
    expect(withChild.repos.map((r) => r.relPath)).toEqual(["child"]);
    // With nested off the child is not discovered, so the parent keeps its gitlink entry.
    const alone = available(await listChanges(parent, { depth: 2, nested: false }));
    expect(alone.repos[0]!.files.map((f) => f.path)).toEqual(["child"]);
  });
});

describe("a hostile repo runs nothing", () => {
  test("fsmonitor, diff.external, textconv, a diff command and a clean filter all stay dead", async () => {
    const dir = repo(join(base, "hostile"), { "a.txt": "aaaa\n", ".gitattributes": "*.txt diff=evil filter=evil\n" });
    const markers = join(base, "markers");
    mkdirSync(markers);
    const hook = (name: string, body: string) => {
      const path = join(base, `${name}.sh`);
      writeFileSync(path, `#!/bin/sh\ntouch '${join(markers, name)}'\n${body}\n`);
      chmodSync(path, 0o755);
      return path;
    };
    const setConfig = () => {
      git(dir, "config", "core.fsmonitor", hook("fsmonitor", "exit 1"));
      git(dir, "config", "diff.external", hook("external", "exit 0"));
      git(dir, "config", "diff.evil.textconv", hook("textconv", 'cat "$1"'));
      git(dir, "config", "diff.evil.command", hook("command", "exit 0"));
      git(dir, "config", "filter.evil.clean", hook("clean", "cat"));
      git(dir, "config", "filter.evil.smudge", hook("smudge", "cat"));
      git(dir, "config", "filter.evil.required", "true");
    };
    setConfig();
    // Same size, new content: status must hash it, which is when a clean filter runs.
    write(join(dir, "a.txt"), "bbbb\n");
    write(join(dir, "b.txt"), "untracked\n");

    // CONTROL: plain git on this repo DOES run them. Without this the test could pass vacuously.
    Bun.spawnSync(["git", "status", "--porcelain"], { cwd: dir, env: gitEnv(process.env) });
    Bun.spawnSync(["git", "diff", "HEAD"], { cwd: dir, env: gitEnv(process.env) });
    Bun.spawnSync(["git", "diff", "HEAD", "--textconv", "--no-ext-diff"], { cwd: dir, env: gitEnv(process.env) });
    const fired = ["fsmonitor", "external", "clean", "textconv"].filter((m) => existsSync(join(markers, m)));
    expect(fired.length).toBeGreaterThan(0);
    rmSync(markers, { recursive: true });
    mkdirSync(markers);

    const res = available(await listChanges(dir, P));
    const files = res.repos[0]!.files.map((f) => f.path).toSorted();
    expect(files).toEqual(["a.txt", "b.txt"]);
    const diff = await fileDiff(dir, params(".", "a.txt"));
    if (!diff.available) throw new Error("hostile diff refused");
    expect(diff.diff).toContain("+bbbb\n");
    await fileDiff(dir, params(".", "b.txt"));
    for (const m of ["fsmonitor", "external", "textconv", "command", "clean", "smudge"]) {
      expect(existsSync(join(markers, m)), `${m} ran`).toBe(false);
    }
  });

  test("an inherited GIT_DIR or GIT_EXTERNAL_DIFF never reaches git", () => {
    const env = gitEnv({ GIT_DIR: "/tmp/x", GIT_EXTERNAL_DIFF: "/bin/evil", HOME: "/h", PATH: "/usr/bin" });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_EXTERNAL_DIFF).toBeUndefined();
    expect(env).toMatchObject({ HOME: "/h", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1" });
  });

  test("a partial clone's missing blob never lazy-fetches through the repo's transport", async () => {
    // A bare source that serves filters, and a blob:none clone of it.
    const src = repo(join(base, "lazy-src"), { "a.txt": "one\n", "b.txt": "two\n" });
    const bare = join(base, "lazy-src.git");
    git(base, "clone", "-q", "--bare", src, bare);
    git(bare, "config", "uploadpack.allowFilter", "true");
    const dir = join(base, "lazy");
    const clone = Bun.spawnSync(
      ["git", "clone", "-q", "--filter=blob:none", "--no-checkout", `file://${bare}`, dir],
      { env: fixtureEnv(), stdout: "pipe", stderr: "pipe" },
    );
    if (clone.exitCode !== 0) throw new Error(`clone: ${clone.stderr.toString()}`);
    // The index names HEAD's blobs, none of which is present. a.txt changed on disk, b.txt is
    // gone: numstat, status and the diff all want the missing HEAD blobs.
    git(dir, "read-tree", "HEAD");
    write(join(dir, "a.txt"), "changed\n");

    const markers = join(base, "lazy-markers");
    mkdirSync(markers);
    const marker = join(base, "lazy-marker.sh");
    writeFileSync(marker, `#!/bin/sh\ntouch '${markers}'/"$1"\nexit 1\n`);
    chmodSync(marker, 0o755);
    const transports = [
      { name: "ssh", set: () => {
        git(dir, "config", "remote.origin.url", "ssh://x/y");
        git(dir, "config", "core.sshCommand", `${marker} ssh`);
      } },
      { name: "ext", set: () => {
        git(dir, "config", "remote.origin.url", `ext::${marker} ext`);
        git(dir, "config", "protocol.ext.allow", "always");
      } },
    ];

    for (const t of transports) {
      t.set();
      // CONTROL: plain git on this clone DOES run the transport. Without this the test could pass
      // vacuously.
      Bun.spawnSync(["git", "diff", "--numstat", "HEAD"], { cwd: dir, env: fixtureEnv(), stdout: "ignore", stderr: "ignore" });
      expect(existsSync(join(markers, t.name)), `${t.name} control`).toBe(true);
      rmSync(markers, { recursive: true });
      mkdirSync(markers);

      const started = Date.now();
      const res = available(await listChanges(dir, P));
      // The list still names both files; the counts the missing blobs would give are simply absent.
      expect(res.repos[0]!.files.map((f) => f.path).toSorted()).toEqual(["a.txt", "b.txt"]);
      await fileDiff(dir, params(".", "a.txt"));
      await fileDiff(dir, params(".", "b.txt"));
      expect(Date.now() - started).toBeLessThan(GIT_TIMEOUT_MS);
      expect(existsSync(join(markers, t.name)), `${t.name} ran`).toBe(false);
    }
  });

  test("core.worktree in a repo's config cannot move the scan", async () => {
    const elsewhere = join(base, "wt-elsewhere");
    mkdirSync(elsewhere);
    write(join(elsewhere, "secret.txt"), "s\n");
    const dir = repo(join(base, "wt"));
    git(dir, "config", "core.worktree", elsewhere);
    write(join(dir, "a.txt"), "changed\n");
    const res = available(await listChanges(dir, P));
    expect(res.repos[0]!.files.map((f) => f.path)).toEqual(["a.txt"]);
  });
});

describe("the last commit (ADR 0065 rule 9)", () => {
  const commitAt = (repoRel: string | null, path: string | null = null) => ({ ...params(repoRel, path), view: "commit" as const });
  function committed(res: ChangeCommit) {
    if (!res.available) throw new Error(`unavailable: ${res.reason}`);
    return res;
  }

  test("parses a raw commit object and name-status output", () => {
    const parent = "a".repeat(40);
    const raw =
      `tree ${"b".repeat(40)}\nparent ${parent}\nparent ${"c".repeat(40)}\n` +
      "author Ada Lovelace <ada@x> 1700000000 +0100\ncommitter C <c@x> 1700000001 +0100\n" +
      "gpgsig -----BEGIN PGP SIGNATURE-----\n \n -----END PGP SIGNATURE-----\n\n" +
      "Fix the thing\nacross two lines\n\nBody text.\n";
    expect(parseCommitObject(raw)).toEqual({ parent, author: "Ada Lovelace", time: 1700000000, subject: "Fix the thing across two lines" });
    expect(parseCommitObject(`tree ${"b".repeat(40)}\nauthor A <a> 1 +0000\n\nroot\n`).parent).toBeNull();
    expect(parseNameStatusZ("M\0a b.txt\0R087\0old.txt\0new.txt\0A\0n\0D\0d\0T\0t\0C100\0x\0y\0U\0u\0")).toEqual([
      { path: "a b.txt", status: "M" },
      { path: "new.txt", oldPath: "old.txt", status: "R" },
      { path: "n", status: "A" },
      { path: "d", status: "D" },
      { path: "t", status: "M" },
      { path: "y", status: "A" },
    ]);
  });

  test("lists HEAD's files with counts, renames and binaries, and serves each diff", async () => {
    const dir = repo(join(base, "commit"), { "a.txt": "one\ntwo\nthree\n", "b.txt": "b\n", "c.txt": "c\nc\nc\n" });
    write(join(dir, "a.txt"), "one\nTWO\nthree\nfour\n");
    git(dir, "rm", "-q", "b.txt");
    git(dir, "mv", "c.txt", "c2.txt");
    write(join(dir, "new.txt"), "x\ny\n");
    write(join(dir, "blob.bin"), new Uint8Array([0, 1, 2, 0, 3]));
    git(dir, "add", "-A");
    git(dir, "-c", "user.name=Agent Smith", "commit", "-q", "-m", "Second\n\nbody");
    const hash = git(dir, "rev-parse", "HEAD").trim();

    const res = committed(await readCommit(dir, commitAt(".")));
    expect(res.repo).toBe(".");
    expect(res.name).toBe("commit");
    expect(res.commit).toMatchObject({ hash, shortHash: hash.slice(0, 7), subject: "Second", author: "Agent Smith" });
    expect(Math.abs(res.commit.time - Date.now() / 1000)).toBeLessThan(120);
    const byPath = Object.fromEntries(res.files.map((f) => [f.path, f]));
    expect(Object.keys(byPath).toSorted()).toEqual(["a.txt", "b.txt", "blob.bin", "c2.txt", "new.txt"]);
    expect(byPath["a.txt"]).toMatchObject({ status: "M", added: 2, removed: 1 });
    expect(byPath["b.txt"]).toMatchObject({ status: "D", removed: 1 });
    expect(byPath["c2.txt"]).toMatchObject({ status: "R", oldPath: "c.txt" });
    expect(byPath["new.txt"]).toMatchObject({ status: "A", added: 2 });
    expect(byPath["blob.bin"]).toMatchObject({ status: "A", binary: true });

    const diff = await commitFileDiff(dir, commitAt(".", "a.txt"));
    expect(diff).toMatchObject({ available: true, status: "M", binary: false, hash });
    if (diff.available) expect(diff.diff).toContain("+TWO\n");
    const renamed = await commitFileDiff(dir, commitAt(".", "c2.txt"));
    expect(renamed).toMatchObject({ available: true, status: "R", oldPath: "c.txt" });
    if (renamed.available) expect(renamed.diff).toContain("rename from c.txt");
    expect(await commitFileDiff(dir, commitAt(".", "blob.bin"))).toMatchObject({ available: true, binary: true, diff: "" });

    // A clean repo with a commit is offered in the list; its uncommitted list is empty.
    const list = available(await listChanges(dir, P));
    expect(list.repos).toEqual([]);
    expect(list.clean).toEqual([{ relPath: ".", name: "commit" }]);
  });

  test("a root commit diffs against the empty tree; a repo with no commits has none", async () => {
    const dir = repo(join(base, "rootcommit"), { "a.txt": "1\n2\n" });
    const res = committed(await readCommit(dir, commitAt(".")));
    expect(res.commit.subject).toBe("init");
    expect(res.files).toEqual([{ path: "a.txt", status: "A", added: 2, removed: 0, binary: false }]);
    const diff = await commitFileDiff(dir, commitAt(".", "a.txt"));
    if (!diff.available) throw new Error("root diff refused");
    expect(diff.diff).toContain("@@ -0,0 +1,2 @@");

    const empty = join(base, "nocommit");
    mkdirSync(empty);
    git(empty, "init", "-q");
    expect(await readCommit(empty, commitAt("."))).toEqual({ available: false, reason: "no-commit" });
    // No commit to show, so the list offers nothing.
    expect(available(await listChanges(empty, P)).clean).toBeUndefined();
  });

  test("refuses a path the commit did not list, a ../ path and an unknown repo", async () => {
    const dir = repo(join(base, "commit-refuse"), { "a.txt": "a\n", "kept.txt": "k\n" });
    write(join(dir, "a.txt"), "b\n");
    git(dir, "commit", "-q", "-am", "change a");
    write(join(dir, "kept.txt"), "uncommitted\n");
    write(join(base, "outside.txt"), "secret\n");
    // kept.txt is in the tree and changed in the worktree, but not in HEAD's diff.
    expect(await commitFileDiff(dir, commitAt(".", "kept.txt"))).toMatchObject({ reason: "unknown-path" });
    expect(await commitFileDiff(dir, commitAt(".", "../outside.txt"))).toMatchObject({ reason: "unknown-path" });
    expect(await commitFileDiff(dir, commitAt(".", "/etc/passwd"))).toMatchObject({ reason: "unknown-path" });
    expect(await commitFileDiff(dir, commitAt("..", "outside.txt"))).toMatchObject({ reason: "unknown-repo" });
    expect(await readCommit(dir, commitAt("nope"))).toMatchObject({ reason: "unknown-repo" });
    expect(await readCommit(dir, commitAt(null))).toMatchObject({ reason: "unknown-repo" });
    expect(await commitFileDiff(dir, commitAt(".", "a.txt"))).toMatchObject({ available: true });
  });

  test("a hostile repo runs nothing on the commit view", async () => {
    const dir = repo(join(base, "commit-hostile"), { "a.txt": "aaaa\n", ".gitattributes": "*.txt diff=evil filter=evil\n" });
    write(join(dir, "a.txt"), "bbbb\n");
    git(dir, "commit", "-q", "-am", "change");
    const markers = join(base, "commit-markers");
    mkdirSync(markers);
    const hook = (name: string, body: string) => {
      const path = join(base, `commit-${name}.sh`);
      writeFileSync(path, `#!/bin/sh\ntouch '${join(markers, name)}'\n${body}\n`);
      chmodSync(path, 0o755);
      return path;
    };
    git(dir, "config", "core.fsmonitor", hook("fsmonitor", "exit 1"));
    git(dir, "config", "diff.external", hook("external", "exit 0"));
    git(dir, "config", "diff.evil.textconv", hook("textconv", 'cat "$1"'));
    git(dir, "config", "diff.evil.command", hook("command", "exit 0"));
    git(dir, "config", "filter.evil.clean", hook("clean", "cat"));
    git(dir, "config", "filter.evil.smudge", hook("smudge", "cat"));
    git(dir, "config", "filter.evil.required", "true");
    git(dir, "config", "log.showSignature", "true");
    git(dir, "config", "gpg.program", hook("gpg", "exit 1"));

    // CONTROL: plain git on this repo DOES run them. Without this the test could pass vacuously.
    Bun.spawnSync(["git", "show", "HEAD"], { cwd: dir, env: gitEnv(process.env), stdout: "ignore", stderr: "ignore" });
    Bun.spawnSync(["git", "diff", "HEAD~1", "HEAD", "--textconv", "--no-ext-diff"], { cwd: dir, env: gitEnv(process.env), stdout: "ignore" });
    const fired = ["external", "textconv"].filter((m) => existsSync(join(markers, m)));
    expect(fired.length).toBeGreaterThan(0);
    rmSync(markers, { recursive: true });
    mkdirSync(markers);

    const res = committed(await readCommit(dir, commitAt(".")));
    expect(res.files.map((f) => f.path)).toEqual(["a.txt"]);
    const diff = await commitFileDiff(dir, commitAt(".", "a.txt"));
    if (!diff.available) throw new Error("hostile commit diff refused");
    expect(diff.diff).toContain("+bbbb\n");
    await listChanges(dir, P);
    for (const m of ["fsmonitor", "external", "textconv", "command", "clean", "smudge", "gpg"]) {
      expect(existsSync(join(markers, m)), `${m} ran`).toBe(false);
    }
  });
});

describe("shared reads (ADR 0065 rule 8)", () => {
  test("concurrent asks share one run, a finished answer serves until the window ends", async () => {
    let clock = 0;
    let runs = 0;
    const shared = new SharedReads<number>(CHANGES_SHARE_MS, () => clock);
    const run = async () => ++runs;
    const [a, b] = await Promise.all([shared.read("k", run), shared.read("k", run)]);
    expect([a, b, runs]).toEqual([1, 1, 1]);
    clock = CHANGES_SHARE_MS - 1;
    expect(await shared.read("k", run)).toBe(1);
    clock = CHANGES_SHARE_MS;
    expect(await shared.read("k", run)).toBe(2);
    expect(await shared.read("other", run)).toBe(3);
  });

  test("a read that throws is not kept", async () => {
    const shared = new SharedReads<number>(CHANGES_SHARE_MS, () => 0);
    await expect(shared.read("k", () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(await shared.read("k", async () => 7)).toBe(7);
  });

  describe("against real git", () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "collie-changes-shared-"));
      repo(join(dir, "r"));
      write(join(dir, "r", "a.txt"), "changed\n");
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    test("two concurrent list asks start git once between them", async () => {
      const root = join(dir, "r");
      // One read alone, to learn how many git runs one list takes.
      const before = gitRuns.spawned;
      await listChanges(root, P);
      const one = gitRuns.spawned - before;
      expect(one).toBeGreaterThan(0);
      sharedLists.clear();
      const start = gitRuns.spawned;
      const [a, b] = await Promise.all([sharedListChanges(root, P), sharedListChanges(root, P)]);
      expect(gitRuns.spawned - start).toBe(one);
      expect(a).toBe(b);
      // Within the window a third ask is answered without git.
      const again = gitRuns.spawned;
      await sharedListChanges(root, P);
      expect(gitRuns.spawned).toBe(again);
      // A different depth is a different key.
      await sharedListChanges(root, { depth: 3, nested: true });
      expect(gitRuns.spawned).toBeGreaterThan(again);
    });

    test("two concurrent diff asks start git once between them, and run again after the window", async () => {
      const root = join(dir, "r");
      sharedDiffs.clear();
      const q = { depth: 2, nested: true, repo: ".", path: "a.txt" };
      const start = gitRuns.spawned;
      const [a, b] = await Promise.all([sharedFileDiff(root, q), sharedFileDiff(root, q)]);
      const one = gitRuns.spawned - start;
      expect(one).toBeGreaterThan(0);
      expect(a).toBe(b);
      await Bun.sleep(CHANGES_SHARE_MS + 50);
      const later = gitRuns.spawned;
      const c = await sharedFileDiff(root, q);
      expect(gitRuns.spawned - later).toBe(one);
      expect(c).not.toBe(a);
    });
  });
});

describe("repoOfFolder", () => {
  test("names the deepest listed repo that holds the folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-changes-panerepo-"));
    try {
      mkdirSync(join(dir, "one", "deep"), { recursive: true });
      mkdirSync(join(dir, "two"), { recursive: true });
      const repos = [{ relPath: "." }, { relPath: "one" }, { relPath: "two" }];
      expect(await repoOfFolder(dir, repos, join(dir, "one", "deep"))).toBe("one");
      expect(await repoOfFolder(dir, repos, dir)).toBe(".");
      expect(await repoOfFolder(dir, [{ relPath: "two" }], join(dir, "one"))).toBeUndefined();
      expect(await repoOfFolder(dir, repos, "")).toBeUndefined();
      // `one` is not a prefix match for `oneway`.
      mkdirSync(join(dir, "oneway"));
      expect(await repoOfFolder(dir, [{ relPath: "one" }], join(dir, "oneway"))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
