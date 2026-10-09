import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  branchSlug,
  expandHome,
  herdrConfigPath,
  herdrDefaultTarget,
  herdrWorktreeDir,
  isWithin,
  nearestWorkTree,
  resolveParentTarget,
} from "./worktree-folder.ts";

// The folder rule for a branch's own folder (ADR 0093), driven against a real temporary home with
// real links, because a rule about links proven on a fake filesystem proves nothing.

let root: string;
let home: string;
let repo: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "collie-wt-folder-")));
  home = join(root, "home", "op");
  repo = join(home, "src", "app");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(join(home, "trees"), { recursive: true });
  await mkdir(join(home, ".config", "x"), { recursive: true });
  await mkdir(join(root, "outside"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ask = (parent: string, branch = "fix-tabs") => resolveParentTarget({ parent, branch, repoRoot: repo, home });

describe("resolveParentTarget — the parent the phone names", () => {
  test("an ordinary folder under home: the child is the branch's slug", async () => {
    expect(await ask(join(home, "trees"), "feat/x-y")).toEqual({ ok: true, path: join(home, "trees", "feat-x-y") });
  });

  test("a leading ~ is home", async () => {
    expect(await ask("~/trees")).toEqual({ ok: true, path: join(home, "trees", "fix-tabs") });
  });

  test("home itself may be the parent", async () => {
    expect(await ask("~")).toEqual({ ok: true, path: join(home, "fix-tabs") });
  });

  test("a relative folder is refused", async () => {
    expect(await ask("trees")).toMatchObject({ ok: false, code: "worktree.folder_invalid" });
  });

  test("a .. segment is refused even when it would land inside home", async () => {
    expect(await ask(`${home}/trees/../trees`)).toMatchObject({ ok: false, code: "worktree.folder_invalid" });
    expect(await ask("~/../op/trees")).toMatchObject({ ok: false, code: "worktree.folder_invalid" });
  });

  test("a control character or an empty string is refused", async () => {
    expect(await ask(`${join(home, "trees")}\n`)).toMatchObject({ ok: true });
    expect(await ask(`${home}/tr\u0000ees`)).toMatchObject({ ok: false, code: "worktree.folder_invalid" });
    expect(await ask(`${home}/tr\u001bees`)).toMatchObject({ ok: false, code: "worktree.folder_invalid" });
    expect(await ask("   ")).toMatchObject({ ok: false, code: "worktree.folder_invalid" });
  });

  test("a folder that is not there, or a file, is refused", async () => {
    expect(await ask(join(home, "nope"))).toMatchObject({ ok: false, code: "worktree.folder_missing" });
    await writeFile(join(home, "notes.txt"), "x");
    expect(await ask(join(home, "notes.txt"))).toMatchObject({ ok: false, code: "worktree.folder_missing" });
  });

  test("a folder outside home is refused", async () => {
    expect(await ask(join(root, "outside"))).toMatchObject({ ok: false, code: "worktree.folder_outside_home" });
    expect(await ask("/")).toMatchObject({ ok: false, code: "worktree.folder_outside_home" });
  });

  test("a link as the parent is refused, even to a folder under home", async () => {
    await symlink(join(home, "trees"), join(home, "trees-link"));
    expect(await ask(join(home, "trees-link"))).toMatchObject({ ok: false, code: "worktree.folder_link" });
  });

  test("a link anywhere on the path below home is refused", async () => {
    await mkdir(join(home, "trees", "deep"), { recursive: true });
    await symlink(join(home, "trees"), join(home, "via"));
    expect(await ask(join(home, "via", "deep"))).toMatchObject({ ok: false, code: "worktree.folder_link" });
  });

  test("a link out of home is refused as outside home", async () => {
    await symlink(join(root, "outside"), join(home, "escape"));
    expect(await ask(join(home, "escape"))).toMatchObject({ ok: false, code: "worktree.folder_outside_home" });
  });

  test("home itself may be a link (Fedora Atomic's /home → /var/home)", async () => {
    const linkedHome = join(root, "linked-home");
    await symlink(home, linkedHome);
    const outcome = await resolveParentTarget({ parent: "~/trees", branch: "b", repoRoot: repo, home: linkedHome });
    expect(outcome).toEqual({ ok: true, path: join(home, "trees", "b") });
    const viaReal = await resolveParentTarget({ parent: join(home, "trees"), branch: "b", repoRoot: repo, home: linkedHome });
    expect(viaReal).toEqual({ ok: true, path: join(home, "trees", "b") });
  });

  test("a dotdir anywhere below home is refused, .git included", async () => {
    expect(await ask(join(home, ".config"))).toMatchObject({ ok: false, code: "worktree.folder_hidden" });
    expect(await ask(join(home, ".config", "x"))).toMatchObject({ ok: false, code: "worktree.folder_hidden" });
    expect(await ask(join(repo, ".git"))).toMatchObject({ ok: false, code: "worktree.folder_hidden" });
  });

  test("the repo's own folder, or a folder inside it, is refused", async () => {
    await mkdir(join(repo, "sub"));
    expect(await ask(repo)).toMatchObject({ ok: false, code: "worktree.folder_in_repo" });
    expect(await ask(join(repo, "sub"))).toMatchObject({ ok: false, code: "worktree.folder_in_repo" });
  });

  test("a target that exists is refused, a dangling link included", async () => {
    await mkdir(join(home, "trees", "fix-tabs"));
    expect(await ask(join(home, "trees"))).toMatchObject({
      ok: false,
      code: "worktree.target_exists",
      path: join(home, "trees", "fix-tabs"),
    });
    await symlink(join(root, "gone"), join(home, "trees", "dangling"));
    expect(await ask(join(home, "trees"), "dangling")).toMatchObject({ ok: false, code: "worktree.target_exists" });
  });

  test("a branch that reads as a flag, or slugs to nothing, is refused", async () => {
    expect(await ask(join(home, "trees"), "-rf")).toMatchObject({ ok: false, code: "worktree.invalid_branch" });
    expect(await ask(join(home, "trees"), "ü")).toMatchObject({ ok: false, code: "worktree.invalid_branch" });
    expect(await ask(join(home, "trees"), "a/.hidden")).toMatchObject({ ok: false, code: "worktree.invalid_branch" });
  });
});

describe("Herdr's default folder (probed on Herdr 0.9.3)", () => {
  test("branchSlug follows Herdr: lower case, every other run one dash, no dash at the ends", () => {
    expect(branchSlug("feat/x-y")).toBe("feat-x-y");
    expect(branchSlug("Feat_A.b")).toBe("feat-a-b");
    expect(branchSlug("wt/a/b+c")).toBe("wt-a-b-c");
    expect(branchSlug("ü@x")).toBe("x");
    expect(branchSlug("worktree/brisk-otter-1a2b")).toBe("worktree-brisk-otter-1a2b");
  });

  test("no config: ~/.herdr/worktrees/<repo folder>/<slug>", async () => {
    expect(await herdrDefaultTarget("/home/op/src/Repo.Name", "feat/x", "/home/op", () => Promise.resolve(null))).toBe(
      "/home/op/.herdr/worktrees/Repo.Name/feat-x",
    );
  });

  test("[worktrees] directory moves it, with ~ expanded", () => {
    expect(herdrWorktreeDir('[worktrees]\ndirectory = "~/wt"\n', "/home/op")).toBe("/home/op/wt");
    expect(herdrWorktreeDir('[worktrees]\ndirectory = "/srv/wt"\n', "/home/op")).toBe("/srv/wt");
  });

  test("a relative value, another key, or a file that does not parse is no setting", () => {
    const fallback = "/home/op/.herdr/worktrees";
    expect(herdrWorktreeDir('[worktrees]\ndirectory = "rel/wt"\n', "/home/op")).toBe(fallback);
    expect(herdrWorktreeDir('worktree_directory = "/srv/wt"\n', "/home/op")).toBe(fallback);
    expect(herdrWorktreeDir("[[[ not toml", "/home/op")).toBe(fallback);
  });

  test("the config file is Herdr's own: XDG_CONFIG_HOME first, then ~/.config", () => {
    expect(herdrConfigPath({ XDG_CONFIG_HOME: "/x/cfg" }, "/home/op")).toBe("/x/cfg/herdr/config.toml");
    expect(herdrConfigPath({}, "/home/op")).toBe("/home/op/.config/herdr/config.toml");
    expect(herdrConfigPath({ XDG_CONFIG_HOME: "relative" }, "/home/op")).toBe("/home/op/.config/herdr/config.toml");
  });
});

describe("the small helpers", () => {
  test("expandHome touches only a leading ~", () => {
    expect(expandHome("~", "/h")).toBe("/h");
    expect(expandHome("~/a", "/h")).toBe("/h/a");
    expect(expandHome("~a", "/h")).toBe("~a");
    expect(expandHome("/a/~", "/h")).toBe("/a/~");
  });

  test("isWithin works on whole segments", () => {
    expect(isWithin("/a/b", "/a")).toBe(true);
    expect(isWithin("/a", "/a")).toBe(true);
    expect(isWithin("/ab", "/a")).toBe(false);
    expect(isWithin("/", "/a")).toBe(false);
  });

  test("nearestWorkTree walks up to the folder holding .git", async () => {
    await mkdir(join(repo, "a", "b"), { recursive: true });
    expect(await nearestWorkTree(join(repo, "a", "b"))).toBe(repo);
    expect(await nearestWorkTree(join(home, "trees"))).toBeNull();
  });
});
