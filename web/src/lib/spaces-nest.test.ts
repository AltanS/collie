import { describe, expect, it } from "vitest";

import { isolateSpaces, nestWorktrees } from "./spaces";
import type { WorkspaceView } from "./types";

// The grouping rules the spaces list leans on. Written against the shape a real herd produces:
// a repo checkout open as one space, its worktrees open as others, and unrelated spaces between.

function space(
  workspaceId: string,
  extra: Partial<WorkspaceView> = {},
): WorkspaceView {
  return {
    workspaceId,
    number: 1,
    label: workspaceId,
    focused: false,
    activeTabId: `${workspaceId}:t1`,
    tabCount: 1,
    paneCount: 1,
    ...extra,
  };
}

const REPO = "/repo/jmds";
const parent = space("w1", { repoRoot: REPO, isWorktree: false });
const child = space("w2", { repoRoot: REPO, isWorktree: true });
const unrelated = space("w3");

describe("nestWorktrees", () => {
  it("puts a worktree one level under the space holding its repo", () => {
    expect(nestWorktrees([parent, child])).toEqual([
      { space: parent, depth: 0 },
      { space: child, depth: 1 },
    ]);
  });

  it("leaves spaces outside any repo flat", () => {
    expect(nestWorktrees([unrelated])).toEqual([{ space: unrelated, depth: 0 }]);
  });

  it("keeps a worktree flat when its repo is not open — nothing to indent under", () => {
    expect(nestWorktrees([child])).toEqual([{ space: child, depth: 0 }]);
  });

  it("moves the whole group to the position of its most recent member", () => {
    // Incoming order is recency: the worktree was used most recently, the repo checkout long ago.
    const rows = nestWorktrees([child, unrelated, parent]);
    expect(rows.map((r) => r.space.workspaceId)).toEqual(["w1", "w2", "w3"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 0]);
  });

  it("groups several worktrees of one repo, in the order they arrived", () => {
    const second = space("w4", { repoRoot: REPO, isWorktree: true });
    const rows = nestWorktrees([parent, second, unrelated, child]);
    expect(rows.map((r) => r.space.workspaceId)).toEqual(["w1", "w4", "w2", "w3"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1, 0]);
  });

  it("keeps two repos apart", () => {
    const otherParent = space("w5", { repoRoot: "/repo/infra", isWorktree: false });
    const otherChild = space("w6", { repoRoot: "/repo/infra", isWorktree: true });
    const rows = nestWorktrees([parent, otherParent, child, otherChild]);
    expect(rows.map((r) => r.space.workspaceId)).toEqual(["w1", "w2", "w5", "w6"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 0, 1]);
  });
});

describe("isolateSpaces (issue #338)", () => {
  const key = (label: string, host = "") => `${host}\u0000\u0000${label}`;
  const all = [parent, child, unrelated];

  it("returns every space when nothing is isolated", () => {
    expect(isolateSpaces(all, null)).toEqual(all);
  });

  it("keeps the isolated repo checkout and its worktrees, and drops the rest", () => {
    expect(isolateSpaces(all, key("w1")).map((w) => w.workspaceId)).toEqual(["w1", "w2"]);
  });

  it("keeps a lone space that has no repo", () => {
    expect(isolateSpaces(all, key("w3")).map((w) => w.workspaceId)).toEqual(["w3"]);
  });

  it("keeps only the worktree when a worktree is isolated", () => {
    expect(isolateSpaces(all, key("w2")).map((w) => w.workspaceId)).toEqual(["w2"]);
  });

  it("does not pull in worktrees of another repo", () => {
    const other = space("w5", { repoRoot: "/repo/infra", isWorktree: true });
    expect(isolateSpaces([...all, other], key("w1")).map((w) => w.workspaceId)).toEqual(["w1", "w2"]);
  });

  it("matches on the machine too, so a same-named space elsewhere is not taken", () => {
    const peer = space("w1", { host: "minibuch" });
    expect(isolateSpaces([peer, unrelated], key("w1", "bluefin"))).toEqual([peer, unrelated]);
    expect(isolateSpaces([peer, unrelated], key("w1", "minibuch"))).toEqual([peer]);
  });

  it("treats a stale key as no filter", () => {
    expect(isolateSpaces(all, key("gone"))).toEqual(all);
  });
});
