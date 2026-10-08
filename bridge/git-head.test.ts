import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findGitDir,
  GIT_DIR_TTL_MS,
  GIT_FORGET_MS,
  GIT_HEAD_TTL_MS,
  GitHeads,
  nodeGitHeadDisk,
  parseGitFile,
  parseHead,
  readGitHead,
  type GitHeadDisk,
} from "./git-head.ts";

const SHA1 = "abc1234def5678abc1234def5678abc1234def56";
const SHA256 = "a".repeat(64);

describe("parseHead", () => {
  test("a branch, with the refs/heads/ prefix gone", () => {
    expect(parseHead("ref: refs/heads/main\n")).toEqual({ kind: "branch", name: "main" });
    expect(parseHead("ref: refs/heads/perf/dashboard-poll-cadence\n")).toEqual({
      kind: "branch",
      name: "perf/dashboard-poll-cadence",
    });
  });

  test("a ref outside refs/heads/ keeps the ref as written", () => {
    expect(parseHead("ref: refs/remotes/origin/main")).toEqual({ kind: "branch", name: "refs/remotes/origin/main" });
  });

  test("a SHA-1 or SHA-256 object name is a detached head", () => {
    expect(parseHead(`${SHA1}\n`)).toEqual({ kind: "detached", sha: SHA1 });
    expect(parseHead(SHA256)).toEqual({ kind: "detached", sha: SHA256 });
  });

  test("anything else is no head at all", () => {
    expect(parseHead("")).toBeNull();
    expect(parseHead("ref: ")).toBeNull();
    expect(parseHead("ref: refs/heads/")).toBeNull();
    expect(parseHead("abc1234")).toBeNull();
    expect(parseHead("ref: refs/heads/a\u0007b")).toBeNull();
    expect(parseHead("ref: refs/heads/a\u202eb")).toBeNull();
    expect(parseHead("ref: refs/heads/a\u2066b")).toBeNull();
    expect(parseHead("ref: not a ref at all")).toBeNull();
    expect(parseHead("ref: heads/main")).toBeNull();
    expect(parseHead(`ref: refs/heads/${"x".repeat(300)}`)).toBeNull();
  });
});

describe("parseGitFile", () => {
  test("an absolute gitdir is taken as written", () => {
    expect(parseGitFile("gitdir: /repo/.git/worktrees/wt\n", "/elsewhere/wt")).toBe("/repo/.git/worktrees/wt");
  });

  test("a relative gitdir (a submodule) resolves against the folder holding the file", () => {
    expect(parseGitFile("gitdir: ../.git/modules/sub\n", "/repo/sub")).toBe("/repo/.git/modules/sub");
  });

  test("a file that is not a gitdir line is nothing", () => {
    expect(parseGitFile("hello\n", "/x")).toBeNull();
    expect(parseGitFile("gitdir:   \n", "/x")).toBeNull();
  });
});

// A real disk, laid out the four ways a folder can sit relative to a checkout.
describe("on a real disk", () => {
  let root = "";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "collie-git-head-"));
    // A repo on a branch, with a nested folder.
    mkdirSync(join(root, "repo", ".git", "worktrees", "wt"), { recursive: true });
    mkdirSync(join(root, "repo", ".git", "modules", "sub"), { recursive: true });
    mkdirSync(join(root, "repo", "src", "deep"), { recursive: true });
    writeFileSync(join(root, "repo", ".git", "HEAD"), "ref: refs/heads/main\n");
    // A linked worktree: `.git` is a FILE naming its own git dir, whose HEAD is detached.
    mkdirSync(join(root, "wt"), { recursive: true });
    writeFileSync(join(root, "wt", ".git"), `gitdir: ${join(root, "repo", ".git", "worktrees", "wt")}\n`);
    writeFileSync(join(root, "repo", ".git", "worktrees", "wt", "HEAD"), `${SHA1}\n`);
    // A submodule: a relative gitdir.
    mkdirSync(join(root, "repo", "sub"), { recursive: true });
    writeFileSync(join(root, "repo", "sub", ".git"), "gitdir: ../.git/modules/sub\n");
    writeFileSync(join(root, "repo", ".git", "modules", "sub", "HEAD"), "ref: refs/heads/feature/x\n");
    // A bare repo: HEAD and objects in the folder itself, no working folder.
    mkdirSync(join(root, "bare.git", "objects"), { recursive: true });
    writeFileSync(join(root, "bare.git", "HEAD"), "ref: refs/heads/main\n");
    // A plain folder in no checkout.
    mkdirSync(join(root, "plain"), { recursive: true });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("a folder inside a repo finds the repo's .git and its branch", async () => {
    const gitDir = await findGitDir(join(root, "repo", "src", "deep"));
    expect(gitDir).toBe(join(root, "repo", ".git"));
    expect(await readGitHead(gitDir!)).toEqual({ kind: "branch", name: "main" });
  });

  test("a linked worktree follows its gitdir file to a detached head", async () => {
    const gitDir = await findGitDir(join(root, "wt"));
    expect(gitDir).toBe(join(root, "repo", ".git", "worktrees", "wt"));
    expect(await readGitHead(gitDir!)).toEqual({ kind: "detached", sha: SHA1 });
  });

  test("a submodule follows its relative gitdir", async () => {
    const gitDir = await findGitDir(join(root, "repo", "sub"));
    expect(gitDir).toBe(join(root, "repo", ".git", "modules", "sub"));
    expect(await readGitHead(gitDir!)).toEqual({ kind: "branch", name: "feature/x" });
  });

  test("a bare repo, a missing folder and a folder in no checkout have no git dir", async () => {
    expect(await findGitDir(join(root, "bare.git"))).toBeNull();
    expect(await findGitDir(join(root, "repo", "gone"))).toBeNull();
    expect(await findGitDir("relative/path")).toBeNull();
    // `plain` sits under the temp dir, which is in no checkout on any sane machine.
    expect(await findGitDir(join(root, "plain"))).toBeNull();
  });

  test("an unreadable HEAD is no head, not an error", async () => {
    if (process.getuid?.() === 0 || process.platform === "win32") return;
    const locked = join(root, "locked");
    mkdirSync(join(locked, ".git"), { recursive: true });
    writeFileSync(join(locked, ".git", "HEAD"), "ref: refs/heads/main\n");
    chmodSync(join(locked, ".git", "HEAD"), 0o000);
    try {
      expect(await readGitHead(join(locked, ".git"))).toBeNull();
    } finally {
      chmodSync(join(locked, ".git", "HEAD"), 0o644);
    }
  });

  test("the reader answers from memory after a refresh, and takes no lock", async () => {
    const heads = new GitHeads(nodeGitHeadDisk);
    await heads.refresh([join(root, "repo", "src"), join(root, "wt"), join(root, "plain")]);
    expect(heads.get(join(root, "repo", "src"))).toEqual({ kind: "branch", name: "main" });
    expect(heads.get(join(root, "wt"))).toEqual({ kind: "detached", sha: SHA1 });
    expect(heads.get(join(root, "plain"))).toBeUndefined();
    // Reading HEAD writes nothing beside it: no index.lock, no HEAD.lock.
    expect(readdirSync(join(root, "repo", ".git")).filter((name) => name.endsWith(".lock"))).toEqual([]);
  });
});

/** A disk held in memory: path to kind, path to text, and a gate a test can hold shut. */
function memoryDisk(files: Record<string, string>, dirList: readonly string[]) {
  const dirs = new Set(dirList);
  const reads: string[] = [];
  let gate: Promise<void> = Promise.resolve();
  const disk: GitHeadDisk = {
    async kind(path) {
      await gate;
      if (dirs.has(path)) return "dir";
      return path in files ? "file" : null;
    },
    async readHead(path) {
      await gate;
      reads.push(path);
      return files[path] ?? null;
    },
  };
  return {
    disk,
    files,
    dirs,
    reads,
    hold(): () => void {
      let open!: () => void;
      gate = new Promise((resolve) => (open = resolve));
      return () => open();
    },
  };
}

describe("GitHeads, the cache", () => {
  const layout = () =>
    memoryDisk({ "/r/.git/HEAD": "ref: refs/heads/main\n" }, ["/r", "/r/.git", "/r/a", "/r/b", "/"]);

  test("the first ask answers nothing and never waits; the read lands for the next one", async () => {
    const mem = layout();
    const release = mem.hold();
    const heads = new GitHeads(mem.disk, () => 0);
    // The disk is held shut: a get that waited on it would never return.
    expect(heads.get("/r/a")).toBeUndefined();
    expect(heads.get("/r/a")).toBeUndefined();
    release();
    await heads.refresh(["/r/a"]);
    expect(heads.get("/r/a")).toEqual({ kind: "branch", name: "main" });
  });

  test("two folders of one checkout read HEAD once", async () => {
    const mem = layout();
    const heads = new GitHeads(mem.disk, () => 0);
    await heads.refresh(["/r/a", "/r/b", "/r/a"]);
    expect(mem.reads.filter((p) => p === "/r/.git/HEAD")).toHaveLength(1);
    expect(heads.get("/r/b")).toEqual({ kind: "branch", name: "main" });
  });

  test("HEAD is re-read once its clock runs out, so a switch shows", async () => {
    const mem = layout();
    let now = 0;
    const heads = new GitHeads(mem.disk, () => now);
    await heads.refresh(["/r/a"]);
    mem.files["/r/.git/HEAD"] = `${SHA1}\n`;
    now = GIT_HEAD_TTL_MS - 1;
    await heads.refresh(["/r/a"]);
    expect(heads.get("/r/a")).toEqual({ kind: "branch", name: "main" });
    now = GIT_HEAD_TTL_MS;
    await heads.refresh(["/r/a"]);
    expect(heads.get("/r/a")).toEqual({ kind: "detached", sha: SHA1 });
  });

  test("a stale get schedules the read itself, so a quiet poll still moves it", async () => {
    const mem = layout();
    let now = 0;
    const heads = new GitHeads(mem.disk, () => now);
    await heads.refresh(["/r/a"]);
    mem.files["/r/.git/HEAD"] = "ref: refs/heads/next\n";
    now = GIT_HEAD_TTL_MS;
    // Answers the old reading at once, and starts the new one.
    expect(heads.get("/r/a")).toEqual({ kind: "branch", name: "main" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(heads.get("/r/a")).toEqual({ kind: "branch", name: "next" });
  });

  test("a folder whose checkout is gone loses its branch", async () => {
    const mem = layout();
    let now = 0;
    const heads = new GitHeads(mem.disk, () => now);
    await heads.refresh(["/r/a"]);
    mem.dirs.delete("/r/.git");
    delete mem.files["/r/.git/HEAD"];
    now = GIT_DIR_TTL_MS;
    await heads.refresh(["/r/a"]);
    expect(heads.get("/r/a")).toBeUndefined();
  });

  test("a folder nobody asks about is forgotten", async () => {
    const mem = layout();
    let now = 0;
    const heads = new GitHeads(mem.disk, () => now);
    await heads.refresh(["/r/a"]);
    now = GIT_FORGET_MS;
    await heads.refresh(["/r/b"]);
    // `/r/a` was dropped with its entry, so a later ask starts from nothing rather than answer stale.
    expect(heads.get("/r/a")).toBeUndefined();
  });

  test("a blank or relative folder is never read", async () => {
    const mem = layout();
    const heads = new GitHeads(mem.disk, () => 0);
    await heads.refresh(["", "r/a"]);
    expect(heads.get("")).toBeUndefined();
    expect(mem.reads).toEqual([]);
  });

  test("a disk that throws leaves no reading and no rejection", async () => {
    const broken: GitHeadDisk = {
      kind: () => Promise.reject(new Error("EIO")),
      readHead: () => Promise.reject(new Error("EIO")),
    };
    const heads = new GitHeads(broken, () => 0);
    await heads.refresh(["/r/a"]);
    expect(heads.get("/r/a")).toBeUndefined();
  });
});
