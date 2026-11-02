import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addWorktree, firstSentence, worktreePaths } from "./worktree-add.ts";

// `addWorktree` against a real git repository in a temporary folder (M81 spec 02):
//
//   1. With no path the checkout goes in Herdr's default folder, `<dir>/<repo name>/<slug>`.
//   2. A base is the starting point; no base is the repo's HEAD.
//   3. A folder that already is a linked worktree of this repo answers `existed` and runs no `add`.
//   4. A refusal carries git's own sentence, and leaves nothing behind.

let root: string;
let home: string;
let repo: string;

/** Run git in `cwd` for the test's own setup, with no operator config. Answers stdout. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: home },
  });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
  return out.trim();
}

const commit = (cwd: string, message: string) =>
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", message);

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "collie-wt-add-")));
  home = join(root, "home");
  repo = join(home, "src", "app");
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await commit(repo, "one");
  await git(repo, "branch", "older");
  await commit(repo, "two");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const deps = (config: string | null = null) => ({ home, readHerdrConfig: () => Promise.resolve(config) });

describe("addWorktree", () => {
  test("no path: Herdr's default folder, a new branch cut from HEAD", async () => {
    const outcome = await addWorktree(deps(), { repoRoot: repo, branch: "Fix/Tabs" });
    const path = join(home, ".herdr", "worktrees", "app", "fix-tabs");
    expect(outcome).toEqual({ ok: true, path, existed: false });
    expect(await git(path, "symbolic-ref", "--short", "HEAD")).toBe("Fix/Tabs");
    expect(await git(path, "rev-parse", "HEAD")).toBe(await git(repo, "rev-parse", "main"));
    expect(worktreePaths(await git(repo, "worktree", "list", "--porcelain"))).toContain(path);
  });

  test("Herdr's configured directory is honoured", async () => {
    const outcome = await addWorktree(deps('[worktrees]\ndirectory = "~/trees"\n'), { repoRoot: repo, branch: "x" });
    expect(outcome).toEqual({ ok: true, path: join(home, "trees", "app", "x"), existed: false });
  });

  test("a given path and a base: the checkout is there, cut from the base", async () => {
    const path = join(home, "elsewhere", "feat-x");
    const outcome = await addWorktree(deps(), { repoRoot: repo, branch: "feat/x", base: "older", path });
    expect(outcome).toEqual({ ok: true, path, existed: false });
    expect(await git(path, "rev-parse", "HEAD")).toBe(await git(repo, "rev-parse", "older"));
  });

  test("a folder that already is a worktree of this repo answers existed, and no add runs", async () => {
    const first = await addWorktree(deps(), { repoRoot: repo, branch: "again" });
    expect(first).toMatchObject({ ok: true, existed: false });
    // The branch exists now, so a second `add -b again` would fail: `existed` proves none ran.
    const second = await addWorktree(deps(), { repoRoot: repo, branch: "again" });
    expect(second).toEqual({ ok: true, path: join(home, ".herdr", "worktrees", "app", "again"), existed: true });
  });

  test("a branch that exists is create_failed with git's own sentence, and no folder is left", async () => {
    const path = join(home, "trees", "older");
    const outcome = await addWorktree(deps(), { repoRoot: repo, branch: "older", path });
    expect(outcome).toEqual({ ok: false, code: "worktree.create_failed", detail: "a branch named 'older' already exists" });
    expect(await Bun.file(join(path, ".git")).exists()).toBe(false);
  });

  test("a plain folder in the way is create_failed, and the folder is untouched", async () => {
    const path = join(home, "trees", "taken");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "mine.txt"), "keep");
    const outcome = await addWorktree(deps(), { repoRoot: repo, branch: "taken", path });
    expect(outcome).toMatchObject({ ok: false, code: "worktree.create_failed" });
    if (outcome.ok) return;
    expect(outcome.detail).toContain("already exists");
    expect(await Bun.file(join(path, "mine.txt")).text()).toBe("keep");
  });

  test("a base that names nothing is create_failed with git's sentence", async () => {
    const outcome = await addWorktree(deps(), { repoRoot: repo, branch: "y", base: "no-such-ref", path: join(home, "trees", "y") });
    expect(outcome).toMatchObject({ ok: false, code: "worktree.create_failed" });
    if (outcome.ok) return;
    expect(outcome.detail).toContain("no-such-ref");
  });

  test("a folder that is not a repo is create_failed", async () => {
    const outcome = await addWorktree(deps(), { repoRoot: join(home, "src"), branch: "z", path: join(home, "trees", "z") });
    expect(outcome).toMatchObject({ ok: false, code: "worktree.create_failed" });
  });

  test("no git on the machine is create_failed, and nothing runs", async () => {
    const outcome = await addWorktree({ ...deps(), git: null }, { repoRoot: repo, branch: "w" });
    expect(outcome).toEqual({ ok: false, code: "worktree.create_failed", detail: "git was not found on this machine" });
    expect(await Bun.file(join(home, ".herdr", "worktrees", "app", "w", ".git")).exists()).toBe(false);
  });

  test("a branch spelled like a flag stays a branch name: argv only, `--` before the path", async () => {
    // The route refuses a leading dash before this is reached; the module still never lets one reach
    // git as an option, so git answers about the name and makes nothing.
    const outcome = await addWorktree(deps(), { repoRoot: repo, branch: "--orphan", path: join(home, "trees", "o") });
    expect(outcome).toMatchObject({ ok: false, code: "worktree.create_failed" });
    expect(await Bun.file(join(home, "trees", "o", ".git")).exists()).toBe(false);
  });
});

describe("the parsers", () => {
  test("worktreePaths reads every worktree line of the porcelain list", () => {
    expect(worktreePaths("worktree /a\nHEAD 1\nbranch refs/heads/main\n\nworktree /b c\nHEAD 2\ndetached\n")).toEqual(["/a", "/b c"]);
  });

  test("firstSentence takes the first line that says something, without its tag", () => {
    expect(firstSentence("\nfatal: a branch named 'x' already exists\nmore\n")).toBe("a branch named 'x' already exists");
    expect(firstSentence("error: nope")).toBe("nope");
    expect(firstSentence("Preparing worktree")).toBe("Preparing worktree");
    expect(firstSentence("  \n")).toBeNull();
  });
});
