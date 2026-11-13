import { afterEach, describe, expect, it } from "vitest";

import { paneRowKey } from "./hosts";
import { __resetFoldedParents, nestPanes, toggleFoldedParent, useFoldedParents } from "./pane-tree";
import type { AgentView } from "./types";
import { renderHook, act } from "@testing-library/react";

const pane = (paneId: string, over: Partial<AgentView> = {}): AgentView => ({
  paneId,
  workspaceId: "w1",
  workspaceLabel: "projects",
  workspaceNumber: 1,
  tabId: "w1:t1",
  agent: "claude",
  status: "idle",
  cwd: "/home/dev/projects",
  focused: false,
  ...over,
});

describe("nestPanes", () => {
  afterEach(() => {
    __resetFoldedParents();
  });

  it("nests live children depth-first with tree guides and leaves orphans flat", () => {
    const main = pane("t1", { paneLabel: "main" });
    const workerA = pane("t2", { paneLabel: "audit-auth", parentPaneId: "t1", status: "done", lastActiveAt: 200, lastSeenAt: 100 });
    const subOfA = pane("t4", { paneLabel: "nested", parentPaneId: "t2", status: "working" });
    const workerB = pane("t3", { paneLabel: "check-migrations", parentPaneId: "t1", status: "idle" });
    const orphan = pane("t9", { paneLabel: "orphan", parentPaneId: "missing" });

    const rows = nestPanes([main, workerA, workerB, subOfA, orphan]);
    expect(rows.map((r) => [r.pane.paneId, r.guides, r.childCount, r.childStatus])).toEqual([
      ["t1", [], 3, "working"],
      ["t2", ["├"], 1, "working"],
      ["t4", ["│", "└"], 0, undefined],
      ["t3", ["└"], 0, undefined],
      ["t9", [], 0, undefined],
    ]);
  });

  it("folds descendants when the parent is folded and surfaces the most urgent descendant status", () => {
    const main = pane("t1", { paneLabel: "main" });
    const workerA = pane("t2", { paneLabel: "audit-auth", parentPaneId: "t1", status: "working" });
    const workerB = pane("t3", { paneLabel: "check-migrations", parentPaneId: "t1", status: "blocked" });

    const folded = new Set([paneRowKey(main)]);
    const rows = nestPanes([main, workerA, workerB], folded);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pane: main,
      guides: [],
      childCount: 2,
      childStatus: "blocked",
      folded: true,
    });
  });

  it("pulls the root ancestor forward when a fresher child precedes it in activity order", () => {
    const older = pane("t0", { paneLabel: "other" });
    const main = pane("t1", { paneLabel: "main" });
    const hotWorker = pane("t2", { paneLabel: "audit-auth", parentPaneId: "t1", status: "working" });

    const rows = nestPanes([hotWorker, older, main]);
    expect(rows.map((r) => r.pane.paneId)).toEqual(["t1", "t2", "t0"]);
  });

  it("never pairs across different crew hosts even when bare pane ids match", () => {
    const leadMain = pane("t1", { host: "mac" });
    const peerChild = pane("t2", { host: "linux", parentPaneId: "t1" });

    const rows = nestPanes([leadMain, peerChild]);
    expect(rows.map((r) => [r.pane.paneId, r.guides, r.childCount])).toEqual([
      ["t1", [], 0],
      ["t2", [], 0],
    ]);
  });

  it("persists and toggles folded parents through the external store", () => {
    const key = paneRowKey(pane("t1"));
    const { result } = renderHook(() => useFoldedParents());
    expect(result.current.has(key)).toBe(false);

    act(() => toggleFoldedParent(key));
    expect(result.current.has(key)).toBe(true);

    act(() => toggleFoldedParent(key));
    expect(result.current.has(key)).toBe(false);
  });
});
