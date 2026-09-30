import { activityAt, activityRanks, cacheRanks, coercePaneOrder, coldAt, inRankOrder } from "./pane-order";
import { paneRowKey } from "./hosts";
import type { AgentView } from "./types";

// The two halves ADR 0071 rests on: activity reads the LATER of the two clocks, and a reading once
// taken is what the list draws from until the operator asks for another. The freeze is what keeps
// the setting from re-opening the fault ADR 0063 closed, so it is pinned here rather than left to
// the component that uses it.

function pane(paneId: string, over: Partial<AgentView> = {}): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "proj",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status: "idle",
    cwd: "/home/you/proj",
    focused: false,
    ...over,
  };
}

const keys = (panes: readonly AgentView[]): string[] => panes.map((p) => p.paneId);

describe("coercePaneOrder", () => {
  it("takes the three it knows and reads anything else as place", () => {
    expect(coercePaneOrder("activity")).toBe("activity");
    expect(coercePaneOrder("place")).toBe("place");
    expect(coercePaneOrder("cache")).toBe("cache");
    // A stored value from a build that spelled it differently, a typo, and nothing at all: all place,
    // so an install that was never told otherwise behaves as it did.
    expect(coercePaneOrder("recent")).toBe("place");
    expect(coercePaneOrder(undefined)).toBe("place");
    expect(coercePaneOrder(true)).toBe("place");
  });
});

describe("activityAt", () => {
  it("takes the later of the agent's clock and the operator's", () => {
    expect(activityAt(pane("p1", { lastActiveAt: 10, lastSeenAt: 40 }))).toBe(40);
    expect(activityAt(pane("p2", { lastActiveAt: 90, lastSeenAt: 40 }))).toBe(90);
  });

  it("reads a bare shell by the only clock a shell has", () => {
    // A shell runs no agent, so it takes no status transitions and `lastActiveAt` never moves for it.
    // Opening it does move `lastSeenAt`, and a shell you were in a minute ago has to be able to
    // outrank an agent you have not opened all day.
    expect(activityAt(pane("p3", { kind: "shell", lastSeenAt: 70 }))).toBe(70);
  });

  it("reads a pane from an older bridge as no reading at all", () => {
    expect(activityAt(pane("p4"))).toBe(0);
  });
});

describe("activityRanks and inRankOrder", () => {
  it("runs newest first", () => {
    const panes = [
      pane("old", { lastActiveAt: 100 }),
      pane("newest", { lastActiveAt: 900 }),
      pane("middle", { lastActiveAt: 500 }),
    ];
    expect(keys(inRankOrder(panes, activityRanks(panes)))).toEqual(["newest", "middle", "old"]);
  });

  it("leaves the panes an older bridge sent in place order, as one block at the end", () => {
    // Activity order DEGRADES to place order rather than to noise: with no readings at all the input
    // order survives, and a mixed herd keeps the timed panes on top with the rest behind them.
    const untimed = [pane("a"), pane("b"), pane("c")];
    expect(keys(inRankOrder(untimed, activityRanks(untimed)))).toEqual(["a", "b", "c"]);

    const mixed = [pane("a"), pane("timed", { lastSeenAt: 5 }), pane("b")];
    expect(keys(inRankOrder(mixed, activityRanks(mixed)))).toEqual(["timed", "a", "b"]);
  });

  it("holds the order it read even after a pane's clock moves", () => {
    // THE FREEZE, and the whole reason the setting is allowed at all (ADR 0071). The reading is taken
    // once; a pane that then finishes a turn repaints where it stands rather than climbing past the
    // row a thumb is already reaching for.
    const panes = [pane("first", { lastActiveAt: 900 }), pane("second", { lastActiveAt: 100 })];
    const ranks = activityRanks(panes);

    const later = [panes[0]!, { ...panes[1]!, lastActiveAt: 5_000 }];
    expect(keys(inRankOrder(later, ranks))).toEqual(["first", "second"]);
    // And the operator's own tap takes a new reading, which is the only thing that reorders it.
    expect(keys(inRankOrder(later, activityRanks(later)))).toEqual(["second", "first"]);
  });

  it("puts a pane that opened after the reading at the END, never at the top", () => {
    // It is genuinely the newest, and the top is exactly where it must not go: every row already
    // drawn would shift down by one under a moving thumb.
    const panes = [pane("first", { lastActiveAt: 900 }), pane("second", { lastActiveAt: 100 })];
    const ranks = activityRanks(panes);
    const withNew = [...panes, pane("fresh", { lastActiveAt: 9_000 })];
    expect(keys(inRankOrder(withNew, ranks))).toEqual(["first", "second", "fresh"]);
  });

  it("is the identity for an empty reading, which is what place order passes", () => {
    const panes = [pane("a", { lastActiveAt: 1 }), pane("b", { lastActiveAt: 900 })];
    expect(keys(inRankOrder(panes, new Map()))).toEqual(["a", "b"]);
  });

  it("ranks by the full row identity, so two machines' panes never share a rank", () => {
    // `w1:p1` names a different terminal on every machine in a crew (the same reason ThreadSidebar
    // takes `paneRowKey` rather than a bare id).
    const panes = [
      pane("w1:p1", { host: "desk", lastActiveAt: 100 }),
      pane("w1:p1", { host: "alpha", lastActiveAt: 900 }),
    ];
    const ranks = activityRanks(panes);
    expect(ranks.size).toBe(2);
    expect(ranks.get(paneRowKey(panes[1]!))).toBe(0);
    expect(inRankOrder(panes, ranks)[0]?.host).toBe("alpha");
  });

  it("does not reorder its input in place", () => {
    const panes = [pane("old", { lastActiveAt: 1 }), pane("new", { lastActiveAt: 900 })];
    inRankOrder(panes, activityRanks(panes));
    expect(keys(panes)).toEqual(["old", "new"]);
  });
});

// The third order (2026-09-30). Same two rules as activity: place stays the default, and the reading
// is taken once. What differs is the question — "which of these am I about to pay to rebuild" — and
// therefore what "nothing to say" means: a cache you have already lost is not one that is going.
describe("coldAt", () => {
  const NOW = 1_700_000_000_000;
  const warm = (over: Partial<AgentView["cache"] & object>): AgentView =>
    pane("p", { cache: { state: "warm", ttlSeconds: 300, ruleId: "r", confidence: "documented", ...over } });

  it("is the expiry itself while there is still a cache to lose", () => {
    expect(coldAt(warm({ expiresAt: NOW + 60_000 }), NOW)).toBe(NOW + 60_000);
  });

  it("ranks last every pane there is nothing left to lose on", () => {
    const last = Number.MAX_SAFE_INTEGER;
    expect(coldAt(pane("p"), NOW)).toBe(last);
    expect(coldAt(warm({ state: "unknown", expiresAt: NOW + 60_000 }), NOW)).toBe(last);
    expect(coldAt(warm({ state: "cold", expiresAt: NOW + 60_000 }), NOW)).toBe(last);
    expect(coldAt(warm({}), NOW)).toBe(last);
  });

  // The same edge the chip reads, so a row and its own hourglass cannot disagree about one pane.
  it("holds a just-expired reading through the grace, and drops it after", () => {
    expect(coldAt(warm({ expiresAt: NOW - 9_000 }), NOW)).toBe(NOW - 9_000);
    expect(coldAt(warm({ expiresAt: NOW - 11_000 }), NOW)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("cacheRanks", () => {
  const NOW = 1_700_000_000_000;
  const withCache = (id: string, msLeft: number | null): AgentView =>
    pane(id, {
      cache:
        msLeft === null
          ? undefined
          : { state: "warm", ttlSeconds: 300, ruleId: "r", confidence: "documented", expiresAt: NOW + msLeft },
    });

  it("puts the cache that dies soonest first", () => {
    const panes = [withCache("late", 600_000), withCache("soon", 60_000), withCache("mid", 300_000)];
    const ranks = cacheRanks(panes, NOW);
    expect(keys(inRankOrder(panes, ranks))).toEqual(["soon", "mid", "late"]);
  });

  it("sinks the panes with no cache to the bottom as a block, in place order", () => {
    const panes = [withCache("none-a", null), withCache("soon", 60_000), withCache("none-b", null)];
    const ranks = cacheRanks(panes, NOW);
    expect(keys(inRankOrder(panes, ranks))).toEqual(["soon", "none-a", "none-b"]);
  });

  // The whole point of a rank map rather than a live sort: a window ticking down must not move a row
  // under a thumb. The reading is the sheet's, and it is taken once.
  it("is a reading, so a minute passing does not move anything", () => {
    const panes = [withCache("late", 600_000), withCache("soon", 60_000)];
    const ranks = cacheRanks(panes, NOW);
    expect(keys(inRankOrder(panes, ranks))).toEqual(["soon", "late"]);
    // `soon` is now cold and `late` is not, and the list still draws what the reader was handed.
    expect(keys(inRankOrder(panes, ranks))).toEqual(["soon", "late"]);
  });
});
