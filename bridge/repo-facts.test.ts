import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repoFactsOf } from "./repo-facts.ts";

// The facts are read off a REAL repository: `git init`, one commit, one linked worktree. The test
// shells out to git to BUILD the fixture; the code under test never does.

function git(cwd: string, ...args: string[]): void {
  const run = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

let root: string;
let main: string;
let linked: string;
let plain: string;
let submodule: string;

beforeAll(() => {
  // realpath: /tmp may be a symlink, and git writes the resolved path into the `.git` file.
  root = realpathSync(mkdtempSync(join(tmpdir(), "repo-facts-")));
  main = join(root, "main");
  linked = join(root, "linked");
  plain = join(root, "plain");
  submodule = join(root, "sub");
  mkdirSync(main);
  git(main, "init", "-q");
  writeFileSync(join(main, "a.txt"), "a\n");
  git(main, "add", "a.txt");
  git(main, "commit", "-q", "-m", "one");
  git(main, "worktree", "add", "-q", "-b", "side", linked);
  mkdirSync(join(main, "src", "deep"), { recursive: true });
  mkdirSync(join(linked, "src"), { recursive: true });
  mkdirSync(plain);
  mkdirSync(submodule);
  writeFileSync(join(submodule, ".git"), "gitdir: ../main/.git/modules/sub\n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("repoFactsOf", () => {
  test("a main checkout is its own repo root and not a worktree", async () => {
    expect(await repoFactsOf(main)).toEqual({ repoRoot: main, isWorktree: false });
  });

  test("a folder inside a main checkout walks up to the checkout", async () => {
    expect(await repoFactsOf(join(main, "src", "deep"))).toEqual({ repoRoot: main, isWorktree: false });
  });

  test("a linked worktree names the main checkout as its repo root", async () => {
    expect(await repoFactsOf(linked)).toEqual({ repoRoot: main, isWorktree: true });
  });

  test("a folder inside a linked worktree walks up to the worktree", async () => {
    expect(await repoFactsOf(join(linked, "src"))).toEqual({ repoRoot: main, isWorktree: true });
  });

  test("a plain folder has no facts", async () => {
    expect(await repoFactsOf(plain)).toBeNull();
  });

  test("a submodule-shaped .git file has no facts", async () => {
    expect(await repoFactsOf(submodule)).toBeNull();
  });

  test("a relative gitdir that does not name a worktree entry has no facts", async () => {
    const odd = join(root, "odd");
    mkdirSync(odd);
    writeFileSync(join(odd, ".git"), "gitdir: ../nowhere\n");
    expect(await repoFactsOf(odd)).toBeNull();
  });

  test("a relative gitdir that does resolve to a worktree entry is read against the file's folder", async () => {
    const rel = join(root, "rel");
    mkdirSync(rel);
    writeFileSync(join(rel, ".git"), "gitdir: ../main/.git/worktrees/side\n");
    expect(await repoFactsOf(rel)).toEqual({ repoRoot: main, isWorktree: true });
  });

  test("the walk stops at home: a dotfiles repo at ~/.git is no repo for a plain folder under it", async () => {
    const home = join(root, "home");
    mkdirSync(join(home, "projects", "plain"), { recursive: true });
    git(home, "init", "-q");
    expect(await repoFactsOf(join(home, "projects", "plain"), undefined, home)).toBeNull();
    expect(await repoFactsOf(home, undefined, home)).toBeNull();
    // A repo of its own under home still reads, and a folder outside home walks as before.
    const own = join(home, "projects", "own");
    mkdirSync(own);
    git(own, "init", "-q");
    expect(await repoFactsOf(join(home, "projects", "own"), undefined, home)).toEqual({ repoRoot: own, isWorktree: false });
    expect(await repoFactsOf(join(main, "src", "deep"), undefined, home)).toEqual({ repoRoot: main, isWorktree: false });
  });

  test("a folder that does not exist, and a relative path, have no facts", async () => {
    expect(await repoFactsOf(join(root, "missing"))).toBeNull();
    expect(await repoFactsOf("relative/path")).toBeNull();
  });
});
