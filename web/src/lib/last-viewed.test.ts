import { renderHook } from "@testing-library/react";

import { paneRowKey } from "./hosts";
import {
  currentLastViewed,
  dropLastViewed,
  forgetLastViewed,
  MAX_LAST_VIEWED,
  recordLastViewed,
  resolveLastViewed,
  useLastViewedMemory,
} from "./last-viewed";
import type { AgentView } from "./types";

function pane(id: string, space: string, over: Partial<AgentView> = {}): AgentView {
  return {
    paneId: id,
    workspaceId: space,
    workspaceLabel: space,
    workspaceNumber: 1,
    tabId: `${space}:t1`,
    agent: "claude",
    status: "idle",
    cwd: `/work/${space}`,
    focused: false,
    ...over,
  };
}

describe("last-viewed store", () => {
  it("records newest first, deduplicates revisits, caps at MAX_LAST_VIEWED, and survives reload", async () => {
    const p1 = pane("p1", "alpha");
    const p2 = pane("p2", "beta");
    const p3 = pane("p3", "gamma");
    const p4 = pane("p4", "delta");
    const p5 = pane("p5", "epsilon");

    recordLastViewed(paneRowKey(p1), "alpha");
    recordLastViewed(paneRowKey(p2), "beta");
    recordLastViewed(paneRowKey(p1), "alpha");
    expect(currentLastViewed().map((r) => r.row)).toEqual([paneRowKey(p1), paneRowKey(p2)]);

    recordLastViewed(paneRowKey(p3), "gamma");
    recordLastViewed(paneRowKey(p4), "delta");
    recordLastViewed(paneRowKey(p5), "epsilon");
    expect(currentLastViewed()).toHaveLength(MAX_LAST_VIEWED);
    expect(currentLastViewed().map((r) => r.row)).toEqual([
      paneRowKey(p5),
      paneRowKey(p4),
      paneRowKey(p3),
      paneRowKey(p1),
    ]);

    vi.resetModules();
    const reloaded = await import("./last-viewed");
    expect(reloaded.currentLastViewed().map((r) => r.row)).toEqual([
      paneRowKey(p5),
      paneRowKey(p4),
      paneRowKey(p3),
      paneRowKey(p1),
    ]);
  });

  it("resolves the 1 most recent live pane on home, skips currentPaneKey inside a pane, and honours exclude", () => {
    const pA = pane("pA", "tidepool");
    const pB = pane("pB", "lumen");
    const pC = pane("pC", "harbor");
    recordLastViewed(paneRowKey(pA), "tidepool");
    recordLastViewed(paneRowKey(pB), "lumen");
    recordLastViewed(paneRowKey(pC), "harbor");

    // From Home (`currentPaneKey === ""`), returns the single most recently viewed pane (`pC`).
    expect(resolveLastViewed(currentLastViewed(), [pA, pB, pC], "")?.paneId).toBe("pC");

    // From inside `pC`, skips `pC` and returns the previous viewed pane (`pB`).
    expect(resolveLastViewed(currentLastViewed(), [pA, pB, pC], paneRowKey(pC))?.paneId).toBe("pB");

    // Excluding pinned panes (`pC` and `pB`) leaves pinned panes in `Pinned` and picks `pA`.
    const isPinned = (p: AgentView) => p.paneId === "pC" || p.paneId === "pB";
    expect(resolveLastViewed(currentLastViewed(), [pA, pB, pC], "", isPinned)?.paneId).toBe("pA");
    expect(resolveLastViewed(currentLastViewed(), [pB, pC], "", isPinned)).toBeUndefined();
  });

  it("drops a closed pane's record via dropLastViewed so a reused id in the same workspace is not misattributed", () => {
    const pA = pane("pA", "tidepool");
    const pB = pane("pB", "lumen");
    recordLastViewed(paneRowKey(pA), "tidepool");
    recordLastViewed(paneRowKey(pB), "lumen");
    expect(currentLastViewed().map((r) => r.row)).toEqual([paneRowKey(pB), paneRowKey(pA)]);

    dropLastViewed(pB);
    expect(currentLastViewed()).toEqual([{ row: paneRowKey(pA), space: "tidepool" }]);

    // Even if multiplexer reuses `pB` inside `lumen`, it was explicitly dropped on close.
    const pBReopened = pane("pB", "lumen", { paneLabel: "brand-new" });
    expect(resolveLastViewed(currentLastViewed(), [pA, pBReopened], "")?.paneId).toBe("pA");

    // Dropping an unvisited pane is a no-op.
    dropLastViewed(pane("never-opened", "lumen"));
    expect(currentLastViewed()).toEqual([{ row: paneRowKey(pA), space: "tidepool" }]);
  });

  it("keeps no stale in-memory fallback when localStorage.setItem throws", () => {
    const p1 = pane("p1", "alpha");
    const p2 = pane("p2", "beta");
    recordLastViewed(paneRowKey(p1), "alpha");
    expect(currentLastViewed()).toEqual([{ row: paneRowKey(p1), space: "alpha" }]);

    const setSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    try {
      expect(() => recordLastViewed(paneRowKey(p2), "beta")).not.toThrow();
      // Storage keeps its previous persisted value (`p1`), with no diverging in-memory cache.
      expect(currentLastViewed()).toEqual([{ row: paneRowKey(p1), space: "alpha" }]);

      const getSpy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });
      try {
        expect(currentLastViewed()).toEqual([]);
      } finally {
        getSpy.mockRestore();
      }
    } finally {
      setSpy.mockRestore();
    }
  });

  it("ignores closed panes, pane ids reused in a different workspace, and trick sessions", () => {
    const pA = pane("pA", "tidepool");
    const pB = pane("pB", "lumen");
    const trick = pane("trick:lodge:legs:legs", "Tricks", { kind: "trick", agent: "legs" });
    recordLastViewed(paneRowKey(pA), "tidepool");
    recordLastViewed(paneRowKey(pB), "lumen");
    recordLastViewed(paneRowKey(trick), "Tricks");

    // `pB` closed and `trick` is a trick session, so `pA` surfaces.
    expect(resolveLastViewed(currentLastViewed(), [pA, trick], "")?.paneId).toBe("pA");

    // `pB` id reused by another workspace (`other-repo`): skipped rather than misattributed.
    const pBReused = pane("pB", "other-repo");
    expect(resolveLastViewed(currentLastViewed(), [pA, pBReused], "")?.paneId).toBe("pA");

    forgetLastViewed();
    expect(currentLastViewed()).toEqual([]);
    expect(resolveLastViewed(currentLastViewed(), [pA], "")).toBeUndefined();
  });

  it("does not resurrect wiped entries from another tab's unpair when recording a new visit", () => {
    const oldPane = pane("w1:p1", "old-space");
    const newPane = pane("w2:p2", "new-space");
    recordLastViewed(paneRowKey(oldPane), "old-space");
    expect(currentLastViewed().map((r) => r.space)).toEqual(["old-space"]);

    // Simulate another open tab running wipeDevice("unpair"), which deletes the key in localStorage.
    localStorage.removeItem("collie:last-viewed:v1");
    expect(currentLastViewed()).toEqual([]);

    recordLastViewed(paneRowKey(newPane), "new-space");
    expect(currentLastViewed()).toEqual([{ row: paneRowKey(newPane), space: "new-space" }]);
  });

  it("records live panes through useLastViewedMemory only while enabled, and skips undefined or trick panes", () => {
    interface MemoryProps {
      viewed: AgentView | undefined;
      enabled: boolean;
    }
    const live = pane("w1:p1", "collie");
    const second = pane("w2:p2", "lumen");
    const trick = pane("trick:lodge:legs:legs", "Tricks", { kind: "trick", agent: "legs" });
    const { rerender } = renderHook<void, MemoryProps>(
      ({ viewed, enabled }) => useLastViewedMemory(viewed, enabled),
      { initialProps: { viewed: live, enabled: false } },
    );
    expect(localStorage.getItem("collie:last-viewed:v1")).toBeNull();
    expect(currentLastViewed()).toEqual([]);

    rerender({ viewed: undefined, enabled: true });
    expect(currentLastViewed()).toEqual([]);

    rerender({ viewed: trick, enabled: true });
    expect(currentLastViewed()).toEqual([]);

    rerender({ viewed: live, enabled: true });
    expect(currentLastViewed()).toEqual([{ row: paneRowKey(live), space: "collie" }]);

    rerender({ viewed: second, enabled: false });
    expect(currentLastViewed()).toEqual([{ row: paneRowKey(live), space: "collie" }]);
  });
});
