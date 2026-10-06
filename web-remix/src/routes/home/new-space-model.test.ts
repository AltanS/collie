/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import type { WorkspaceView } from "@web/lib/types";

import { NO_FOLDERS, folderName, hasFolders, visibleFolders, worktreeRepos } from "./new-space-model";

const space = (workspaceId: string, extra: Partial<WorkspaceView> = {}): WorkspaceView => ({
  workspaceId,
  number: 1,
  label: workspaceId,
  focused: false,
  activeTabId: "t1",
  tabCount: 1,
  paneCount: 1,
  ...extra,
});

describe("folderName", () => {
  test("names the last segment, ignoring one trailing slash", () => {
    expect(folderName("/srv/app")).toBe("app");
    expect(folderName("/srv/app/")).toBe("app");
  });
  test("the root names itself", () => {
    expect(folderName("/")).toBe("/");
  });
});

describe("visibleFolders", () => {
  test("takes home out of both lists, whatever its trailing slash", () => {
    const list = visibleFolders({ recent: ["/home/op", "/srv/a"], favourites: ["/home/op/", "/srv/b"], home: "/home/op/" });
    expect(list.recent).toEqual(["/srv/a"]);
    expect(list.favourites).toEqual(["/srv/b"]);
  });
  test("an unknown home removes nothing", () => {
    expect(visibleFolders({ recent: ["/a"], favourites: [], home: "" }).recent).toEqual(["/a"]);
  });
});

describe("hasFolders", () => {
  test("is false for the empty list and true for either half", () => {
    expect(hasFolders(NO_FOLDERS)).toBe(false);
    expect(hasFolders({ ...NO_FOLDERS, recent: ["/a"] })).toBe(true);
    expect(hasFolders({ ...NO_FOLDERS, favourites: ["/a"] })).toBe(true);
  });
});

describe("worktreeRepos", () => {
  test("offers a repo's own checkout, once, in list order, and never a worktree's space", () => {
    const repos = worktreeRepos([
      space("w1", { repoRoot: "/r/a", isWorktree: false, label: "alpha" }),
      space("w2", { repoRoot: "/r/a", isWorktree: true, label: "alpha-fix" }),
      space("w3", { label: "no repo" }),
      space("w4", { repoRoot: "/r/b", isWorktree: false, label: "beta" }),
    ]);
    expect(repos).toEqual([
      { workspaceId: "w1", repoRoot: "/r/a", label: "alpha" },
      { workspaceId: "w4", repoRoot: "/r/b", label: "beta" },
    ]);
  });
  test("a space that does not say whether it is a worktree is not offered", () => {
    expect(worktreeRepos([space("w1", { repoRoot: "/r/a" })])).toEqual([]);
  });
});
