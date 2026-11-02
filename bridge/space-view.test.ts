import { describe, expect, test } from "bun:test";

import { mergeSnapshot, parsePeerSnapshot, type PeerContribution } from "./crew/merge.ts";
import type { GitHead, GitHeadSurface } from "./git-head.ts";
import { spaceFolders, withSpaceContext, withSpacesContext, type SpaceContextSources } from "./space-view.ts";
import type { SnapshotResponse, WorkspaceView } from "./types.ts";
import { memoryWorktreeBases } from "./worktree-bases.ts";

const REPO = "/home/op/code/openplate-workspace";
const WT = "/home/op/.herdr/worktrees/openplate-workspace/worktree-eager-summit-7987";
const BRANCH: GitHead = { kind: "branch", name: "worktree/eager-summit-7987" };
const MAIN: GitHead = { kind: "branch", name: "main" };

function space(overrides: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    workspaceId: "w1",
    number: 1,
    label: "openplate-workspace",
    focused: false,
    activeTabId: "w1:t1",
    tabCount: 1,
    paneCount: 1,
    ...overrides,
  };
}

const worktreeSpace = (): WorkspaceView =>
  space({ workspaceId: "w2", number: 2, label: "worktree-eager-summit-7987", repoRoot: REPO, isWorktree: true, folder: WT });

/** A head reader that answers from a fixed map, as `GitHeads.get` answers from its cache. */
function heads(map: Record<string, GitHead>): GitHeadSurface {
  return { get: (folder) => map[folder] };
}

async function sources(map: Record<string, GitHead>, bases: Record<string, string>): Promise<SpaceContextSources> {
  const store = memoryWorktreeBases();
  for (const [folder, base] of Object.entries(bases)) await store.record(folder, { base, createdAt: 1 });
  return { gitHeads: heads(map), bases: store };
}

describe("withSpaceContext — present", () => {
  test("a worktree space carries its branch and the base it was cut from", async () => {
    const from = await sources({ [WT]: BRANCH }, { [WT]: "main" });
    expect(withSpaceContext(worktreeSpace(), from)).toEqual({ ...worktreeSpace(), gitHead: BRANCH, base: "main" });
  });

  test("a detached head rides as it was read, full object name and all", async () => {
    const detached: GitHead = { kind: "detached", sha: "abc1234def5678abc1234def5678abc1234def56" };
    const from = await sources({ [WT]: detached }, {});
    expect(withSpaceContext(worktreeSpace(), from).gitHead).toEqual(detached);
  });

  test("the repo's own checkout carries its branch and never a base, even with one stored for its folder", async () => {
    const main = space({ repoRoot: REPO, isWorktree: false, folder: REPO });
    const from = await sources({ [REPO]: MAIN }, { [REPO]: "develop" });
    const out = withSpaceContext(main, from);
    expect(out.gitHead).toEqual(MAIN);
    expect("base" in out).toBe(false);
  });
});

describe("withSpaceContext — absent, never a placeholder", () => {
  test("no head read yet and no base stored: the same object, no keys", async () => {
    const view = worktreeSpace();
    const out = withSpaceContext(view, await sources({}, {}));
    expect(out).toBe(view);
    expect("gitHead" in out).toBe(false);
    expect("base" in out).toBe(false);
  });

  test("a base with no head yet carries the base alone", async () => {
    const out = withSpaceContext(worktreeSpace(), await sources({}, { [WT]: "main" }));
    expect("gitHead" in out).toBe(false);
    expect(out.base).toBe("main");
  });

  test("a head with no stored base (a worktree made outside Collie) carries the head alone", async () => {
    const out = withSpaceContext(worktreeSpace(), await sources({ [WT]: BRANCH }, {}));
    expect(out.gitHead).toEqual(BRANCH);
    expect("base" in out).toBe(false);
  });

  test("no head reader at all (a server built by hand) attaches no head", async () => {
    const store = memoryWorktreeBases();
    const out = withSpaceContext(worktreeSpace(), { bases: store });
    expect("gitHead" in out).toBe(false);
  });
});

describe("withSpaceContext — a space that is not a worktree serialises as before", () => {
  test("a space with no folder is the same object, whatever the readers hold", async () => {
    const view = space();
    const from = await sources({ "/anything": MAIN }, { "/anything": "main" });
    expect(withSpaceContext(view, from)).toBe(view);
  });

  test("a whole list with nothing to add is the same list, so no snapshot byte moves", async () => {
    const list = [space(), space({ workspaceId: "w3", number: 3, folder: "/tmp/no-repo" })];
    expect(withSpacesContext(list, await sources({}, {}))).toBe(list);
  });

  test("a list with one worktree changes only that row", async () => {
    const plain = space();
    const list = [plain, worktreeSpace()];
    const out = withSpacesContext(list, await sources({ [WT]: BRANCH }, { [WT]: "main" }));
    expect(out).not.toBe(list);
    expect(out[0]).toBe(plain);
    expect(out[1]).toMatchObject({ gitHead: BRANCH, base: "main" });
  });
});

describe("spaceFolders", () => {
  test("every space folder and nothing for a space without one", () => {
    expect(spaceFolders([space(), worktreeSpace(), space({ folder: REPO })])).toEqual([WT, REPO]);
  });
});

describe("a member's space view through the lead", () => {
  const memberView = (): WorkspaceView => ({ ...worktreeSpace(), gitHead: BRANCH, base: "main" });

  test("the lead's parse of a member body keeps both fields as they came", () => {
    const parsed = parsePeerSnapshot({ sessions: [], agents: [], shellPanes: [], workspaces: [memberView()], tabs: [] });
    expect(parsed?.workspaces).toEqual([memberView()]);
  });

  test("the merged snapshot carries the member's fields beside its host tag", () => {
    const body = parsePeerSnapshot({ sessions: [], agents: [], shellPanes: [], workspaces: [memberView()], tabs: [] });
    const peer: PeerContribution = {
      state: {
        memberId: "bluefin-hc",
        health: "reachable",
        lastSeenAt: 1,
        reason: null,
        version: null,
        conflict: null,
        preflight: null,
      },
      name: "bluefin-hc",
      body,
    };
    const local: SnapshotResponse = {
      bridge: "connected",
      agents: [],
      shellPanes: [],
      workspaces: [],
      tabs: [],
      sessions: [],
      notifications: { snoozedUntil: null },
      update: {
        current: "1.0.0",
        latest: null,
        latestUrl: null,
        releaseAvailable: false,
        majorAvailable: null,
        majorUrl: null,
        installKind: "detached-checkout",
        dismissedVersion: null,
        dismissedCrewVersion: null,
        bridgeStale: false,
        restartNeeded: false,
        checkedAt: null,
      },
      ts: 1,
    };
    const merged = mergeSnapshot(local, { self: { id: "bluefin", name: "bluefin" }, peers: [peer], now: 1 });
    expect(merged.workspaces).toEqual([{ ...memberView(), host: "bluefin-hc" }]);
  });
});
