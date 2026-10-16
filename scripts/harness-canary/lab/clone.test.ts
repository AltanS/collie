import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchInClone, checkSource, cloneDirOf, defaultLabRoot, ensureClone } from "./clone";
import { realGit } from "./publish";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});
const temp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lab-clone-")));
  dirs.push(dir);
  return dir;
};
const git = (cwd: string, ...args: string[]): string => {
  const done = realGit(cwd, ["-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  if (done.code !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr}`);
  return done.stdout.trim();
};

/** An origin repo with one commit on main, and a checkout of it (the "given repo"). */
interface Origin {
  readonly bare: string;
  readonly checkout: string;
  readonly root: string;
}

function origin(): Origin {
  const root = temp();
  const bare = join(root, "origin.git");
  mkdirSync(bare);
  git(bare, "init", "--quiet", "--bare", "--initial-branch=main");
  const checkout = join(root, "checkout");
  git(root, "clone", "--quiet", bare, checkout);
  git(checkout, "checkout", "--quiet", "-B", "main");
  writeFileSync(join(checkout, "file.txt"), "one\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "--quiet", "-m", "one");
  git(checkout, "push", "--quiet", "origin", "main");
  return { bare, checkout, root };
}

describe("the lab clone", () => {
  test("the first use clones the origin of the given repo into <lab root>/clone", () => {
    const { checkout, root } = origin();
    const labRoot = join(root, "lab");
    const dir = ensureClone(checkout, labRoot, "/nowhere");
    expect(dir).toBe(cloneDirOf(labRoot));
    // The fixture is written through git, which may check it out with CRLF on Windows.
    expect(readFileSync(join(dir, "file.txt"), "utf8").replaceAll("\r\n", "\n")).toBe("one\n");
  });

  test("each use resets the clone to origin/main, and the given repo is never touched", () => {
    const { checkout, root } = origin();
    const labRoot = join(root, "lab");
    const dir = ensureClone(checkout, labRoot, "/nowhere");
    // The clone is dirtied, and origin moves on.
    writeFileSync(join(dir, "file.txt"), "dirty\n");
    writeFileSync(join(dir, "stray.txt"), "x\n");
    writeFileSync(join(checkout, "file.txt"), "two\n");
    git(checkout, "commit", "--quiet", "-am", "two");
    git(checkout, "push", "--quiet", "origin", "main");
    const before = git(checkout, "status", "--porcelain") + git(checkout, "branch", "--list") + git(checkout, "worktree", "list");
    ensureClone(checkout, labRoot, "/nowhere");
    // The fixture is written through git, which may check it out with CRLF on Windows.
    expect(readFileSync(join(dir, "file.txt"), "utf8").replaceAll("\r\n", "\n")).toBe("two\n");
    expect(existsSync(join(dir, "stray.txt"))).toBe(false);
    expect(git(checkout, "status", "--porcelain") + git(checkout, "branch", "--list") + git(checkout, "worktree", "list")).toBe(before);
  });

  test("a repo under ~/apps is refused", () => {
    const { checkout, root } = origin();
    const home = join(root, "home");
    const apps = join(home, "apps");
    mkdirSync(apps, { recursive: true });
    const live = join(apps, "collie-stable");
    git(root, "clone", "--quiet", checkout, live);
    expect(() => checkSource(live, home)).toThrow(/under .*apps/);
    expect(() => checkSource(checkout, home)).not.toThrow();
  });

  test("a checkout with a detached HEAD is refused", () => {
    const { checkout } = origin();
    git(checkout, "checkout", "--quiet", "--detach");
    expect(() => checkSource(checkout, "/nowhere")).toThrow(/detached HEAD/);
  });

  test("a repo with no origin, or no folder, is refused", () => {
    const root = temp();
    const bare = join(root, "plain");
    mkdirSync(bare);
    git(bare, "init", "--quiet", "--initial-branch=main");
    expect(() => checkSource(bare, "/nowhere")).toThrow(/no origin/);
    expect(() => checkSource(join(root, "missing"), "/nowhere")).toThrow(/does not exist/);
  });

  test("branchInClone sees a branch the lab left, and not one it did not", () => {
    const { checkout, root } = origin();
    const labRoot = join(root, "lab");
    const dir = ensureClone(checkout, labRoot, "/nowhere");
    expect(branchInClone("harness-lab/claude-2.1.301", labRoot)).toBe(false);
    git(dir, "branch", "harness-lab/claude-2.1.301");
    expect(branchInClone("harness-lab/claude-2.1.301", labRoot)).toBe(true);
  });

  test("the default lab root is under ~/.cache/collie-lab, and the variable moves it", () => {
    expect(defaultLabRoot({}, "/home/u")).toBe(join("/home/u", ".cache", "collie-lab", "harness-lab"));
    expect(defaultLabRoot({ COLLIE_HARNESS_LAB_DIR: "/x/lab" }, "/home/u")).toBe("/x/lab");
  });
});
