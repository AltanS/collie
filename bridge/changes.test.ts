import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  capDiff,
  changesParams,
  discoverRepos,
  fileDiff,
  gitEnv,
  listChanges,
  MAX_DIFF_LINES,
  parseNumstatZ,
  parseStatusV2,
  syntheticAddedDiff,
} from "./changes.ts";
import type { PaneChangesResponse } from "./types.ts";

// Real git, in throwaway folders. The module's whole job is how it drives git, so a fake would
// test the fake.

let base: string;

/** Plain git for building fixtures — NOT the hardened runner under test. */
function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args],
    { cwd, env: gitEnv(process.env), stdout: "pipe", stderr: "pipe" },
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

function available(res: PaneChangesResponse) {
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
    expect(at("")).toEqual({ depth: 2, nested: true, repo: null, path: null });
    expect(at("?depth=0").depth).toBe(1);
    expect(at("?depth=99").depth).toBe(4);
    expect(at("?depth=abc").depth).toBe(2);
    expect(at("?nested=0").nested).toBe(false);
    expect(at("?nested=1").nested).toBe(true);
    expect(at("?repo=.&path=a%20b").path).toBe("a b");
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
    expect(await listChanges("p", "", P)).toEqual({ paneId: "p", available: false, reason: "no-folder" });
    expect(await fileDiff("p", "", params(".", "a.txt"))).toMatchObject({ available: false, reason: "no-folder" });
  });

  test("lists modified, added, deleted, renamed and untracked files with counts", async () => {
    const dir = repo(join(base, "basic"), { "a.txt": "one\ntwo\nthree\n", "b.txt": "b\n", "c.txt": "c\n" });
    write(join(dir, "a.txt"), "one\nTWO\nthree\nfour\n");
    git(dir, "rm", "-q", "b.txt");
    git(dir, "mv", "c.txt", "c2.txt");
    write(join(dir, "new.txt"), "x\ny\n");
    git(dir, "add", "new.txt");
    write(join(dir, "loose.txt"), "1\n2\n3\n");
    const res = available(await listChanges("p", dir, P));
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

    const diff = await fileDiff("p", dir, params(".", "a.txt"));
    expect(diff).toMatchObject({ available: true, status: "M", binary: false, truncated: false });
    if (diff.available) expect(diff.diff).toContain("+TWO\n");

    const renamed = await fileDiff("p", dir, params(".", "c2.txt"));
    expect(renamed).toMatchObject({ available: true, status: "R", oldPath: "c.txt" });
    if (renamed.available) expect(renamed.diff).toContain("rename from c.txt");

    const loose = await fileDiff("p", dir, params(".", "loose.txt"));
    if (!loose.available) throw new Error("loose unavailable");
    expect(loose.diff).toContain("@@ -0,0 +1,3 @@\n+1\n+2\n+3\n");
  });

  test("a subfolder of a repo names the repo `..`", async () => {
    const dir = repo(join(base, "up"), { "sub/a.txt": "a\n" });
    write(join(dir, "sub/a.txt"), "b\n");
    const res = available(await listChanges("p", join(dir, "sub"), P));
    expect(res.repos.map((r) => r.relPath)).toEqual([".."]);
    expect(res.repos[0]!.files[0]!.path).toBe("sub/a.txt");
    expect(await fileDiff("p", join(dir, "sub"), params("..", "sub/a.txt"))).toMatchObject({ available: true });
  });

  test("refuses an unlisted path, a ../ path and an unknown repo", async () => {
    const dir = repo(join(base, "refuse"), { "a.txt": "a\n", "clean.txt": "clean\n" });
    write(join(dir, "a.txt"), "changed\n");
    write(join(base, "outside.txt"), "secret\n");
    expect(await fileDiff("p", dir, params(".", "clean.txt"))).toMatchObject({ reason: "unknown-path" });
    expect(await fileDiff("p", dir, params(".", "../outside.txt"))).toMatchObject({ reason: "unknown-path" });
    expect(await fileDiff("p", dir, params(".", "/etc/passwd"))).toMatchObject({ reason: "unknown-path" });
    expect(await fileDiff("p", dir, params("..", "outside.txt"))).toMatchObject({ reason: "unknown-repo" });
    expect(await fileDiff("p", dir, params("nope", "a.txt"))).toMatchObject({ reason: "unknown-repo" });
    expect(await fileDiff("p", dir, params(null, "a.txt"))).toMatchObject({ reason: "unknown-repo" });
  });

  test("an untracked symlink out of the repo is listed but never read", async () => {
    const dir = repo(join(base, "link"));
    write(join(base, "link-target.txt"), "secret\nsecret\n");
    symlinkSync(join(base, "link-target.txt"), join(dir, "leak"));
    symlinkSync("a.txt", join(dir, "inside"));
    const res = available(await listChanges("p", dir, P));
    const leak = res.repos[0]!.files.find((f) => f.path === "leak");
    expect(leak).toMatchObject({ status: "?", added: 0 });
    expect(await fileDiff("p", dir, params(".", "leak"))).toMatchObject({ available: false, reason: "unknown-path" });
    // A link that stays inside shows what git would show: the link's own text, not the file.
    const inside = await fileDiff("p", dir, params(".", "inside"));
    if (!inside.available) throw new Error("inside link refused");
    expect(inside.diff).toContain("+a.txt\n");
  });

  test("binary files carry no body", async () => {
    const dir = repo(join(base, "bin"), { "img.bin": "\0\x01\x02" });
    write(join(dir, "img.bin"), new Uint8Array([0, 1, 2, 3, 4]));
    write(join(dir, "new.bin"), new Uint8Array([9, 0, 9]));
    const res = available(await listChanges("p", dir, P));
    const files = Object.fromEntries(res.repos[0]!.files.map((f) => [f.path, f]));
    expect(files["img.bin"]).toMatchObject({ binary: true });
    expect(files["new.bin"]).toMatchObject({ binary: true, status: "?" });
    expect(await fileDiff("p", dir, params(".", "img.bin"))).toMatchObject({ binary: true, diff: "" });
    expect(await fileDiff("p", dir, params(".", "new.bin"))).toMatchObject({ binary: true, diff: "" });
  });

  test("a long diff is truncated", async () => {
    const dir = repo(join(base, "long"));
    write(join(dir, "a.txt"), Array.from({ length: 6000 }, (_, i) => `line ${i}`).join("\n") + "\n");
    write(join(dir, "big.txt"), Array.from({ length: 6000 }, (_, i) => `line ${i}`).join("\n") + "\n");
    for (const path of ["a.txt", "big.txt"]) {
      const res = await fileDiff("p", dir, params(".", path));
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
    const res = available(await listChanges("p", dir, P));
    const files = Object.fromEntries(res.repos[0]!.files.map((f) => [f.path, f]));
    expect(files["staged.txt"]).toMatchObject({ status: "A", added: 2 });
    expect(files["loose.txt"]).toMatchObject({ status: "?", added: 1 });
    const diff = await fileDiff("p", dir, params(".", "staged.txt"));
    if (!diff.available) throw new Error("staged unavailable");
    expect(diff.diff).toContain("+s1\n+s2\n");
  });

  test("an untracked folder is one entry and has no body", async () => {
    const dir = repo(join(base, "udir"));
    write(join(dir, "fresh/one.txt"), "1\n");
    write(join(dir, "fresh/two.txt"), "2\n");
    const res = available(await listChanges("p", dir, P));
    expect(res.repos[0]!.files.map((f) => f.path)).toEqual(["fresh/"]);
    expect(await fileDiff("p", dir, params(".", "fresh/"))).toMatchObject({ directory: true, diff: "" });
  });
});

describe("discovery", () => {
  test("finds a repo the parent gitignores, and the parent does not list it", async () => {
    const ws = repo(join(base, "ws"), { ".gitignore": "member/\n", "readme.md": "ws\n" });
    const member = repo(join(ws, "member"));
    write(join(member, "a.txt"), "member change\n");
    write(join(ws, "readme.md"), "ws change\n");
    const res = available(await listChanges("p", ws, P));
    expect(res.repos.map((r) => r.relPath).toSorted()).toEqual([".", "member"]);
    const parent = res.repos.find((r) => r.relPath === ".")!;
    expect(parent.files.map((f) => f.path)).toEqual(["readme.md"]);
    const diff = await fileDiff("p", ws, params("member", "a.txt"));
    expect(diff).toMatchObject({ available: true, repo: "member" });
  });

  test("a plain folder with repos below it works, and an untracked nested repo is shown once", async () => {
    const projects = join(base, "projects");
    mkdirSync(projects);
    const one = repo(join(projects, "one"));
    write(join(one, "a.txt"), "x\n");
    const res = available(await listChanges("p", projects, P));
    expect(res.repos.map((r) => r.relPath)).toEqual(["one"]);

    // Not ignored, not a submodule: the parent's status would say `? inner/`.
    const outer = repo(join(base, "outer"));
    const inner = repo(join(outer, "inner"));
    write(join(inner, "a.txt"), "y\n");
    const res2 = available(await listChanges("p", outer, P));
    expect(res2.repos.map((r) => r.relPath)).toEqual(["inner"]);
  });

  test("depth bounds the walk, and nested=false looks at the containing repo only", async () => {
    const top = join(base, "deep");
    mkdirSync(top);
    repo(join(top, "a/b/c"));
    expect((await discoverRepos(top, 2, true)).repos).toHaveLength(0);
    expect((await discoverRepos(top, 3, true)).repos.map((r) => r.relPath)).toEqual(["a/b/c"]);
    const ws = repo(join(base, "flat"));
    repo(join(ws, "child"));
    expect((await discoverRepos(ws, 2, false)).repos.map((r) => r.relPath)).toEqual(["."]);
    // The diff route uses the same discovery, so a nested repo is unknown with nested off.
    write(join(ws, "child/a.txt"), "z\n");
    expect(await fileDiff("p", ws, params("child", "a.txt", { nested: false }))).toMatchObject({
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
    const withChild = available(await listChanges("p", parent, P));
    expect(withChild.repos.map((r) => r.relPath)).toEqual(["child"]);
    // With nested off the child is not discovered, so the parent keeps its gitlink entry.
    const alone = available(await listChanges("p", parent, { depth: 2, nested: false }));
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

    const res = available(await listChanges("p", dir, P));
    const files = res.repos[0]!.files.map((f) => f.path).toSorted();
    expect(files).toEqual(["a.txt", "b.txt"]);
    const diff = await fileDiff("p", dir, params(".", "a.txt"));
    if (!diff.available) throw new Error("hostile diff refused");
    expect(diff.diff).toContain("+bbbb\n");
    await fileDiff("p", dir, params(".", "b.txt"));
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

  test("core.worktree in a repo's config cannot move the scan", async () => {
    const elsewhere = join(base, "wt-elsewhere");
    mkdirSync(elsewhere);
    write(join(elsewhere, "secret.txt"), "s\n");
    const dir = repo(join(base, "wt"));
    git(dir, "config", "core.worktree", elsewhere);
    write(join(dir, "a.txt"), "changed\n");
    const res = available(await listChanges("p", dir, P));
    expect(res.repos[0]!.files.map((f) => f.path)).toEqual(["a.txt"]);
  });
});
