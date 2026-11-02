import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addWorktree,
  firstSentence,
  matchWorktree,
  parseWorktreeList,
  targetExistsDetail,
  worktreePaths,
  type WorktreeBlock,
} from "./worktree-add.ts";

// `addWorktree` against a real git repository in a temporary folder (M81 spec 02):
//
//   1. With no path the checkout goes in Herdr's default folder, `<dir>/<repo name>/<slug>`.
//   2. A base is the starting point; no base is the repo's HEAD.
//   3. A folder that already is the same finished worktree of this repo, on the branch asked for,
//      answers `existed` and runs no `add`. Another branch, or a locked entry, is `target_exists`.
//   4. A refusal carries git's own sentence, and leaves nothing behind.
//   5. Two creates for one folder spawn one `git worktree add` (spec 07).
//   6. A timed-out add removes the checkout it half made, and only that one (spec 07).
//   7. The new branch tracks nothing, whatever the repo's `branch.autoSetupMerge` (spec 07).

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

  test("the same folder asked for on another branch is target_exists, naming the branch it holds", async () => {
    // The slugs of `feat/a` and `feat-a` collide: the second must not open the first's checkout.
    const path = join(home, "trees", "feat-a");
    expect(await addWorktree(deps(), { repoRoot: repo, branch: "feat/a", path })).toMatchObject({ ok: true, existed: false });
    expect(await addWorktree(deps(), { repoRoot: repo, branch: "feat-a", path })).toEqual({
      ok: false,
      code: "worktree.target_exists",
      detail: "that folder holds branch feat/a",
      path,
    });
  });

  test("a locked entry (a create still running, or one killed half way) is target_exists, not existed", async () => {
    const path = join(home, "trees", "half");
    expect(await addWorktree(deps(), { repoRoot: repo, branch: "half", path })).toMatchObject({ ok: true, existed: false });
    await git(repo, "worktree", "lock", "--reason", "initializing", path);
    expect(await addWorktree(deps(), { repoRoot: repo, branch: "half", path })).toEqual({
      ok: false,
      code: "worktree.target_exists",
      detail: "a create is still running in that folder",
      path,
    });
  });

  test("the repo's own checkout is never existed", async () => {
    expect(await addWorktree(deps(), { repoRoot: repo, branch: "main", path: repo })).toMatchObject({
      ok: false,
      code: "worktree.target_exists",
      detail: "that folder is the repository's own checkout",
    });
  });

  test("the new branch tracks nothing, even where the repo would set an upstream", async () => {
    await git(repo, "config", "branch.autoSetupMerge", "always");
    const path = join(home, "trees", "loose");
    expect(await addWorktree(deps(), { repoRoot: repo, branch: "loose", base: "older", path })).toMatchObject({ ok: true });
    const merge = Bun.spawnSync(["git", "config", "--get", "branch.loose.merge"], { cwd: repo, env: { ...process.env, HOME: home } });
    expect(merge.exitCode).toBe(1);
  });

  test("two creates for one folder at once spawn one git worktree add, and both open the checkout", async () => {
    const log = join(root, "git.log");
    const wrapper = join(root, "git-wrapper.sh");
    await writeFile(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${Bun.which("git") ?? "git"}' "$@"\n`);
    await chmod(wrapper, 0o755);
    const path = join(home, "trees", "race");
    // Two requests with two ids: the receipts cannot join them, the folder can.
    const [a, b] = await Promise.all([
      addWorktree({ ...deps(), git: wrapper }, { repoRoot: repo, branch: "race", path }),
      addWorktree({ ...deps(), git: wrapper }, { repoRoot: repo, branch: "race", path }),
    ]);
    const adds = (await readFile(log, "utf8")).split("\n").filter((line) => line.includes("worktree add"));
    expect(adds).toHaveLength(1);
    expect([a, b]).toEqual([
      { ok: true, path, existed: false },
      { ok: true, path, existed: true },
    ]);
  });

  test("a create waiting on a failed one for its folder reports the failure, and runs no add of its own", async () => {
    await git(repo, "branch", "taken");
    const log = join(root, "git.log");
    const wrapper = join(root, "git-wrapper.sh");
    await writeFile(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${Bun.which("git") ?? "git"}' "$@"\n`);
    await chmod(wrapper, 0o755);
    const path = join(home, "trees", "taken");
    const [a, b] = await Promise.all([
      addWorktree({ ...deps(), git: wrapper }, { repoRoot: repo, branch: "taken", path }),
      addWorktree({ ...deps(), git: wrapper }, { repoRoot: repo, branch: "taken", path }),
    ]);
    expect(a).toEqual({ ok: false, code: "worktree.create_failed", detail: "a branch named 'taken' already exists" });
    expect(b).toEqual(a);
    expect((await readFile(log, "utf8")).split("\n").filter((line) => line.includes("worktree add"))).toHaveLength(1);
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

describe("a timed-out add", () => {
  /** A fake git: an empty worktree list, an add that sleeps past any timeout, a remove it records. */
  async function sleepyGit(): Promise<{ git: string; removes: () => Promise<string[]> }> {
    const log = join(root, "removes.log");
    const script = join(root, "sleepy-git.sh");
    await writeFile(
      script,
      [
        "#!/bin/sh",
        'for arg in "$@"; do',
        '  case "$arg" in',
        "    list) exit 0 ;;",
        "    add) exec sleep 5 ;;",
        `    remove) printf '%s\\n' "$*" >> '${log}'; exit 0 ;;`,
        "  esac",
        "done",
        "exit 0",
        "",
      ].join("\n"),
    );
    await chmod(script, 0o755);
    const removes = async () => {
      try {
        return (await readFile(log, "utf8")).split("\n").filter((line) => line !== "");
      } catch {
        return [];
      }
    };
    return { git: script, removes };
  }

  test("removes the half-made checkout of a folder that was not there, and says so", async () => {
    const fake = await sleepyGit();
    const path = join(home, "trees", "slow");
    const outcome = await addWorktree({ ...deps(), git: fake.git, timeoutMs: 200 }, { repoRoot: repo, branch: "slow", path });
    expect(outcome).toEqual({
      ok: false,
      code: "worktree.create_failed",
      detail: "git worktree add took longer than 0.2 s; the half-made checkout was removed",
    });
    const removes = await fake.removes();
    expect(removes).toHaveLength(1);
    expect(removes[0]).toEndWith(`worktree remove --force --force -- ${path}`);
  });

  test("never removes a folder that was there before the call", async () => {
    const fake = await sleepyGit();
    const path = join(home, "trees", "mine");
    await mkdir(path, { recursive: true });
    const outcome = await addWorktree({ ...deps(), git: fake.git, timeoutMs: 200 }, { repoRoot: repo, branch: "mine", path });
    expect(outcome).toEqual({ ok: false, code: "worktree.create_failed", detail: "git worktree add did not finish within 0.2 s" });
    expect(await fake.removes()).toEqual([]);
  });
});

describe("the parsers", () => {
  test("worktreePaths reads every worktree line of the porcelain list", () => {
    expect(worktreePaths("worktree /a\nHEAD 1\nbranch refs/heads/main\n\nworktree /b c\nHEAD 2\ndetached\n")).toEqual(["/a", "/b c"]);
  });

  test("parseWorktreeList reads each entry's branch and state", () => {
    const porcelain = [
      "worktree /r",
      "HEAD 1",
      "branch refs/heads/main",
      "",
      "worktree /t/a",
      "HEAD 2",
      "branch refs/heads/feat/a",
      "locked initializing",
      "",
      "worktree /t/b",
      "HEAD 3",
      "detached",
      "prunable gitdir file points to non-existent location",
      "",
      "worktree /bare",
      "bare",
      "",
    ].join("\n");
    expect(parseWorktreeList(porcelain)).toEqual([
      { path: "/r", branch: "refs/heads/main", bare: false, locked: false, prunable: false },
      { path: "/t/a", branch: "refs/heads/feat/a", bare: false, locked: true, prunable: false },
      { path: "/t/b", branch: null, bare: false, locked: false, prunable: true },
      { path: "/bare", branch: null, bare: true, locked: false, prunable: false },
    ]);
  });

  test("parseWorktreeList drops an entry whose path held a newline", () => {
    // `/t/x\nevil` prints as two lines; the second is no field git prints.
    expect(worktreePaths("worktree /r\nHEAD 1\nbranch refs/heads/main\n\nworktree /t/x\nevil\nHEAD 2\nbranch refs/heads/x\n")).toEqual(["/r"]);
    // `/t/x\n\nevil` splits the entry at the blank line: the half before it goes too.
    expect(worktreePaths("worktree /r\nHEAD 1\n\nworktree /t/x\n\nevil\nHEAD 2\nbranch refs/heads/x\n")).toEqual(["/r"]);
  });

  test("matchWorktree: only a finished linked worktree on the branch asked for is the same", async () => {
    const block = (over: Partial<WorktreeBlock>): WorktreeBlock => ({
      path: "/t/a",
      branch: "refs/heads/a",
      bare: false,
      locked: false,
      prunable: false,
      ...over,
    });
    const main: WorktreeBlock = { path: "/r", branch: "refs/heads/main", bare: false, locked: false, prunable: false };
    const onDisk = (path: string) => Promise.resolve(path === "/gone" ? null : path);
    const ask = (blocks: WorktreeBlock[], path = "/t/a", branch = "a") =>
      matchWorktree([main, ...blocks], { path, branch, main: "/r", realpath: onDisk });
    expect(await ask([block({})])).toEqual({ kind: "same" });
    expect(await ask([block({ branch: "refs/heads/b" })])).toEqual({ kind: "other-branch", branch: "b" });
    expect(await ask([block({ branch: null })])).toEqual({ kind: "other-branch", branch: null });
    expect(await ask([block({ locked: true })])).toEqual({ kind: "locked" });
    expect(await ask([block({ prunable: true })])).toEqual({ kind: "prunable" });
    expect(await ask([block({ bare: true })])).toEqual({ kind: "bare" });
    expect(await ask([], "/r", "main")).toEqual({ kind: "main" });
    expect(await ask([])).toEqual({ kind: "absent" });
    expect(await ask([block({ path: "/gone" })], "/gone")).toEqual({ kind: "absent" });
  });

  test("targetExistsDetail names each state in one plain sentence", () => {
    expect(targetExistsDetail({ kind: "other-branch", branch: "feat/a" })).toBe("that folder holds branch feat/a");
    expect(targetExistsDetail({ kind: "locked" })).toBe("a create is still running in that folder");
    expect(targetExistsDetail({ kind: "prunable" })).toBe("git lists that folder as prunable");
  });

  test("firstSentence takes the first line that says something, without its tag", () => {
    expect(firstSentence("\nfatal: a branch named 'x' already exists\nmore\n")).toBe("a branch named 'x' already exists");
    expect(firstSentence("error: nope")).toBe("nope");
    expect(firstSentence("Preparing worktree")).toBe("Preparing worktree");
    expect(firstSentence("  \n")).toBeNull();
  });
});
