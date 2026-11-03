import { describe, expect, it } from "vitest";

import { isolateSpaces, nestWorktrees, paneSpace, repoNameOf, spaceWorktreeContext } from "./spaces";
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
    expect(isolateSpaces(all, [])).toEqual(all);
  });

  it("keeps the isolated repo checkout and its worktrees, and drops the rest", () => {
    expect(isolateSpaces(all, [key("w1")]).map((w) => w.workspaceId)).toEqual(["w1", "w2"]);
  });

  it("keeps a lone space that has no repo", () => {
    expect(isolateSpaces(all, [key("w3")]).map((w) => w.workspaceId)).toEqual(["w3"]);
  });

  it("keeps only the worktree when a worktree is isolated", () => {
    expect(isolateSpaces(all, [key("w2")]).map((w) => w.workspaceId)).toEqual(["w2"]);
  });

  it("does not pull in worktrees of another repo", () => {
    const other = space("w5", { repoRoot: "/repo/infra", isWorktree: true });
    expect(isolateSpaces([...all, other], [key("w1")]).map((w) => w.workspaceId)).toEqual(["w1", "w2"]);
  });

  it("matches on the machine too, so a same-named space elsewhere is not taken", () => {
    const peer = space("w1", { host: "minibuch" });
    expect(isolateSpaces([peer, unrelated], [key("w1", "bluefin")])).toEqual([peer, unrelated]);
    expect(isolateSpaces([peer, unrelated], [key("w1", "minibuch")])).toEqual([peer]);
  });

  it("treats a stale key as no filter", () => {
    expect(isolateSpaces(all, [key("gone")])).toEqual(all);
  });

  // Issue #527: the filter holds several workspaces, and the Spaces list keeps each one's spaces.
  it("keeps the spaces of every chosen workspace, in the list's order", () => {
    const other = space("w5", { repoRoot: "/repo/infra", isWorktree: true });
    expect(isolateSpaces([...all, other], [key("w5"), key("w1")]).map((w) => w.workspaceId)).toEqual(["w1", "w2", "w5"]);
    expect(isolateSpaces(all, [key("w3"), key("w2")]).map((w) => w.workspaceId)).toEqual(["w2", "w3"]);
  });

  it("ignores a stale key beside a live one, and filters nothing when every key is stale", () => {
    expect(isolateSpaces(all, [key("gone"), key("w3")]).map((w) => w.workspaceId)).toEqual(["w3"]);
    expect(isolateSpaces(all, [key("gone"), key("lost")])).toEqual(all);
  });
});

// M81 spec 06: what a worktree space's second line says, standalone and nested.
describe("spaceWorktreeContext", () => {
  const SHA = "abc1234def5678abc1234def5678abc1234def56";
  const wt = space("w2", {
    label: "worktree-eager-summit-7987",
    repoRoot: "/home/op/code/openplate-workspace",
    isWorktree: true,
    folder: "/home/op/.herdr/worktrees/openplate-workspace/worktree-eager-summit-7987",
    gitHead: { kind: "branch", name: "worktree/eager-summit-7987" },
    base: "main",
  });

  it("names the repo, the branch and the base for a standalone worktree", () => {
    expect(spaceWorktreeContext(wt, false)).toEqual({
      repo: "openplate-workspace",
      head: { kind: "branch", name: "worktree/eager-summit-7987" },
      base: "main",
    });
  });

  it("leaves the repo out under its repo's own row", () => {
    expect(spaceWorktreeContext(wt, true)).toEqual({
      repo: null,
      head: { kind: "branch", name: "worktree/eager-summit-7987" },
      base: "main",
    });
  });

  it("reads the repo's name off a Windows path and past a trailing separator", () => {
    expect(spaceWorktreeContext({ ...wt, repoRoot: "C:\\code\\openplate-workspace\\" }, false)?.repo).toBe("openplate-workspace");
  });

  it("keeps a detached head as it came", () => {
    expect(spaceWorktreeContext({ ...wt, gitHead: { kind: "detached", sha: SHA } }, true)?.head).toEqual({
      kind: "detached",
      sha: SHA,
    });
  });

  it("leaves out each part that is absent, never a placeholder", () => {
    const { gitHead: _head, base: _base, ...bare } = wt;
    expect(spaceWorktreeContext(bare, false)).toEqual({ repo: "openplate-workspace", head: null, base: null });
    expect(spaceWorktreeContext({ ...bare, base: "main" }, true)).toEqual({ repo: null, head: null, base: "main" });
    expect(spaceWorktreeContext(bare, true)).toBeNull();
  });

  it("drops an empty branch name or an empty base from a peer", () => {
    expect(spaceWorktreeContext({ ...wt, gitHead: { kind: "branch", name: "" }, base: "" }, true)).toBeNull();
  });

  it("says nothing for a space that is not a worktree, even with a head on it", () => {
    expect(spaceWorktreeContext({ ...parent, gitHead: { kind: "branch", name: "main" } }, false)).toBeNull();
    expect(spaceWorktreeContext(unrelated, false)).toBeNull();
  });
});

// Issue #666: the repository's name, once, for every surface that names a worktree's repo.
describe("repoNameOf", () => {
  it("is the last segment of a posix root, past a trailing slash", () => {
    expect(repoNameOf({ repoRoot: "/home/op/code/membero" })).toBe("membero");
    expect(repoNameOf({ repoRoot: "/home/op/code/membero/" })).toBe("membero");
  });

  it("reads a Windows root, with or without a trailing backslash", () => {
    expect(repoNameOf({ repoRoot: "C:\\Users\\x\\repo" })).toBe("repo");
    expect(repoNameOf({ repoRoot: "C:\\Users\\x\\repo\\" })).toBe("repo");
  });

  it("is null without a repo root, or with a root that has no segment", () => {
    expect(repoNameOf({})).toBeNull();
    expect(repoNameOf({ repoRoot: "/" })).toBeNull();
  });
});

describe("paneSpace", () => {
  const w1 = space("w1", { host: "lodge", repoRoot: "/a/one", isWorktree: true });
  const w1Other = space("w1", { host: "attic", repoRoot: "/b/two", isWorktree: false });

  it("joins on the machine and the space id, so two machines' w1 stay apart", () => {
    expect(paneSpace({ host: "attic", workspaceId: "w1" }, [w1, w1Other])).toBe(w1Other);
    expect(paneSpace({ host: "lodge", workspaceId: "w1" }, [w1, w1Other])).toBe(w1);
  });

  it("reads an untagged pane as the untagged space, and answers nothing for no match or no list", () => {
    const solo = space("w1", { repoRoot: "/a/one" });
    expect(paneSpace({ workspaceId: "w1" }, [solo])).toBe(solo);
    expect(paneSpace({ host: "lodge", workspaceId: "w9" }, [w1])).toBeUndefined();
    expect(paneSpace({ workspaceId: "w1" }, undefined)).toBeUndefined();
  });
});
