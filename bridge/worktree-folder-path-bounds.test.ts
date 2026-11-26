import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { checkedParentDir, isWithin, resolveParentTarget, resolveSetFolderTarget } from "./worktree-folder.ts";

test("the branch destination including its generated name must stay out of its source checkout", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "worktree-bound-")));
  const projects = join(home, "projects");
  const repoRoot = join(projects, "widget");
  try {
    await mkdir(repoRoot, { recursive: true });
    const req = { home, repoRoot, branch: "notes" };
    expect(await resolveSetFolderTarget({ ...req, dir: projects })).toMatchObject({ ok: false, code: "worktree.folder_in_repo" });
    expect(await resolveParentTarget({ ...req, parent: projects, branch: "widget" })).toMatchObject({ ok: false, code: "worktree.folder_in_repo" });
    expect(await resolveParentTarget({ ...req, parent: projects })).toEqual({ ok: true, path: join(projects, "notes") });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("worktree containment compares whole components and recognises a trailing separator on the same directory", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "worktree-parts-")));
  try {
    const hidden = join(home, "..draft");
    await mkdir(hidden);
    expect(await checkedParentDir(hidden, home)).toEqual({ ok: false, code: "worktree.folder_hidden" });
    expect(isWithin(home, `${home}${sep}`)).toBe(true);
    expect(isWithin(hidden, home)).toBe(true);
    expect(isWithin(home, hidden)).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a setting cannot turn a hidden source name into a hidden destination folder", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "worktree-hidden-")));
  const repoRoot = join(home, "src", ".website");
  const dir = join(home, "checkouts");
  try {
    await mkdir(repoRoot, { recursive: true });
    await mkdir(dir);
    expect(await resolveSetFolderTarget({ home, repoRoot, dir, branch: "docs" })).toMatchObject({ ok: false, code: "worktree.folder_hidden" });
    expect(await resolveParentTarget({ home, repoRoot, parent: dir, branch: "docs" })).toEqual({ ok: true, path: join(dir, "docs") });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
