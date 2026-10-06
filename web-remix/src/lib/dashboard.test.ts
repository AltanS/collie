/// <reference types="bun" />
// The dashboard's pure seams (wave 2): pins, frozen ranks, the order table, hidden machines, the
// change counts and the cache chip's view. The components draw from these; the rules live here.
import { describe, expect, test } from "bun:test";

import { cacheChipView, COLD_GRACE_MS } from "@web/lib/cache-view";
import { paneRowKey } from "@web/lib/hosts";
import type { AgentView, ChangesResponse, PaneCache, ServerSummary } from "@web/lib/types";

import {
  countFor,
  failCount,
  recordCount,
  seededCounts,
  keepChangeCount,
  resetChangeCountCache,
  targetsIdentity,
  watchChangeCounts,
  type ChangeCounts,
  type WorkspaceChangeTarget,
} from "./change-counts";
import { createFrozenRanks } from "./frozen-ranks";
import { MAX_HIDDEN_MACHINES, nextHiddenMachines } from "./hidden-machines";
import { inRankOrder, isRanked, ORDER_SEGMENTS, ORDERS, rankedHeading } from "./pane-order";
import { MAX_PINS, pinMatcher, pinnedList, prunePins, showsPinHint, PIN_HINT_MIN_ROWS, type Pin } from "./pins";

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

const ids = (panes: readonly AgentView[]): string[] => panes.map((p) => p.paneId);

describe("pins", () => {
  test("a pin is added, matched and removed", () => {
    const a = pane("p1");
    const herd = [a, pane("p2")];
    const on = pinnedList([], a, true, herd, 10);
    expect(on).toHaveLength(1);
    expect(pinMatcher(on)(a)).toBe(true);
    expect(pinMatcher(on)(pane("p2"))).toBe(false);
    expect(pinnedList(on, a, false, herd, 11)).toEqual([]);
  });

  test("pinning twice keeps one record, with the newer time", () => {
    const a = pane("p1");
    const twice = pinnedList(pinnedList([], a, true, [a], 1), a, true, [a], 2);
    expect(twice).toHaveLength(1);
    expect(twice[0]?.at).toBe(2);
  });

  test("a row key reused by a pane in another workspace drops the old pin", () => {
    const a = pane("p1");
    const list = pinnedList([], a, true, [a], 1);
    const moved = pane("p1", { workspaceId: "w2", workspaceLabel: "other", tabId: "w2:t1" });
    expect(prunePins(list, [moved], null)).toEqual([]);
  });

  test(`past ${MAX_PINS} the oldest dormant record goes first, and the new one stays`, () => {
    const live = Array.from({ length: MAX_PINS }, (_, i) => pane(`p${i}`));
    const none: Pin[] = [];
    let list = live.reduce((acc, p, i) => pinnedList(acc, p, true, live, 100 + i), none);
    // One dormant record (its pane is gone), older than every live one.
    list = [{ row: paneRowKey(pane("gone")), space: "proj", at: 1 }, ...list].slice(0, MAX_PINS);
    const fresh = pane("fresh");
    const next = pinnedList(list, fresh, true, live, 999);
    expect(next).toHaveLength(MAX_PINS);
    expect(next.some((p) => p.row === paneRowKey(pane("gone")))).toBe(false);
    expect(pinMatcher(next)(fresh)).toBe(true);
  });

  test("the hint shows only before any pin, unretired, over enough rows", () => {
    expect(showsPinHint(false, 0, PIN_HINT_MIN_ROWS)).toBe(true);
    expect(showsPinHint(true, 0, PIN_HINT_MIN_ROWS)).toBe(false);
    expect(showsPinHint(false, 1, PIN_HINT_MIN_ROWS)).toBe(false);
  });
});

describe("frozen ranks", () => {
  const herd = [pane("a", { lastActiveAt: 10 }), pane("b", { lastActiveAt: 30 }), pane("c", { lastActiveAt: 20 })];

  test("place order has no ranks", () => {
    expect(createFrozenRanks().ranks("place", herd).size).toBe(0);
  });

  test("a poll does not move a row; a reread does", () => {
    const frozen = createFrozenRanks();
    const first = frozen.ranks("activity", herd);
    expect(ids(inRankOrder(herd, first))).toEqual(["b", "c", "a"]);
    // The poll: "a" became the most recent. The reading in force does not change.
    const polled = [pane("a", { lastActiveAt: 99 }), herd[1]!, herd[2]!];
    expect(frozen.ranks("activity", polled)).toBe(first);
    expect(ids(inRankOrder(polled, frozen.ranks("activity", polled)))).toEqual(["b", "c", "a"]);
    // The operator's tap.
    frozen.reread();
    expect(ids(inRankOrder(polled, frozen.ranks("activity", polled)))).toEqual(["a", "b", "c"]);
  });

  test("a new order takes a new reading", () => {
    const frozen = createFrozenRanks(() => 0);
    const activity = frozen.ranks("activity", herd);
    expect(frozen.ranks("cache", herd)).not.toBe(activity);
  });

  test("a first reading over an empty herd is retaken once panes arrive", () => {
    const frozen = createFrozenRanks();
    expect(frozen.ranks("activity", []).size).toBe(0);
    expect(frozen.ranks("activity", herd).size).toBe(3);
  });
});

describe("pane order table", () => {
  test("three orders, in web/'s order, each with a label and a glyph", () => {
    expect(ORDERS).toEqual(["place", "activity", "cache"]);
    for (const o of ORDERS) expect(ORDER_SEGMENTS[o].label).toStartWith("paneOrder.");
  });

  test("the ranked heading names the order", () => {
    expect(isRanked("place")).toBe(false);
    expect(rankedHeading("activity")).toBe("paneOrder.recent");
    expect(rankedHeading("cache")).toBe("paneOrder.coldest");
  });
});

describe("hidden machines", () => {
  const server = (id: string, isLead: boolean): ServerSummary => ({ id, name: id, isLead, reachable: true, protocol: "ok", lastSeenAt: 0 });
  const servers = [server("lead", true), server("peer", false)];

  test("hide and show one machine", () => {
    const hidden = nextHiddenMachines([], "peer", true, servers);
    expect(hidden).toContain("peer");
    expect(nextHiddenMachines(hidden, "peer", false, servers)).not.toContain("peer");
  });

  test("hiding twice stores it once, and the list stays bounded", () => {
    const twice = nextHiddenMachines(nextHiddenMachines([], "peer", true, servers), "peer", true, servers);
    expect(twice.filter((h) => h === "peer")).toHaveLength(1);
    const many = Array.from({ length: MAX_HIDDEN_MACHINES + 5 }, (_, i) => `m${i}`);
    expect(nextHiddenMachines(many, "peer", true, servers).length).toBeLessThanOrEqual(MAX_HIDDEN_MACHINES);
  });
});

describe("change counts", () => {
  const scope = {};
  const targets: WorkspaceChangeTarget[] = [
    { key: "g1", workspaceId: "w1", scope },
    { key: "g2", workspaceId: "w2", scope },
  ];
  const lookup = { depth: 2, nested: true };

  test("a target with nothing read yet is loading", () => {
    expect(countFor(new Map(), "g1")).toEqual({ kind: "loading" });
  });

  test("a kept count seeds a remount, so it does not pulse again", () => {
    resetChangeCountCache();
    keepChangeCount(targets[0]!, lookup, { kind: "clean" });
    const seeded = seededCounts(new Map(), targets, lookup);
    expect(seeded.get("g1")).toEqual({ kind: "clean" });
    expect(seeded.has("g2")).toBe(false);
  });

  test("the same count keeps the same map; a new one makes a new map", () => {
    const one: ChangeCounts = new Map([["g1", { kind: "changed", files: 2, added: 3, removed: 1 }]]);
    expect(recordCount(one, "g1", { kind: "changed", files: 2, added: 3, removed: 1 })).toBe(one);
    const two = recordCount(one, "g1", { kind: "changed", files: 3, added: 3, removed: 1 });
    expect(two).not.toBe(one);
    expect(countFor(two, "g1")).toMatchObject({ files: 3 });
  });

  test("a failed read leaves a shown count alone and ends a loading one", () => {
    const shown: ChangeCounts = new Map([["g1", { kind: "clean" }]]);
    expect(failCount(shown, "g1")).toBe(shown);
    expect(countFor(failCount(new Map(), "g2"), "g2")).toEqual({ kind: "unavailable" });
  });

  test("the identity changes with the targets", () => {
    expect(targetsIdentity(targets)).toBe(targetsIdentity([...targets]));
    expect(targetsIdentity(targets)).not.toBe(targetsIdentity(targets.slice(0, 1)));
  });

  test("the watch reads every target and reports each change", async () => {
    resetChangeCountCache();
    const had = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", { value: { visibilityState: "visible", addEventListener: () => {} }, configurable: true });
    const asked: string[] = [];
    let changes = 0;
    const ctl = new AbortController();
    try {
      const watch = watchChangeCounts(
        () => targets,
        () => lookup,
        () => {
          changes += 1;
        },
        ctl.signal,
        async (subject) => {
          asked.push(subject.kind === "space" ? subject.spaceId : "?");
          const answer: ChangesResponse = { available: false, reason: "no-folder" };
          return answer;
        },
      );
      await new Promise((r) => setTimeout(r, 10));
      expect(asked.toSorted()).toEqual(["w1", "w2"]);
      expect(changes).toBeGreaterThan(0);
      expect(countFor(watch.counts(), "g1").kind).toBe("no-folder");
    } finally {
      ctl.abort();
      if (had === undefined) Reflect.deleteProperty(globalThis, "document");
      else Object.defineProperty(globalThis, "document", had);
    }
  });
});

describe("cache chip view", () => {
  const base: PaneCache = { state: "warm", ttlSeconds: 300, ruleId: "r", confidence: "documented" };

  test("warm counts down in whole minutes", () => {
    expect(cacheChipView({ ...base, expiresAt: 12 * 60_000 + 5 }, 0)).toMatchObject({ tone: "warm", label: "12m" });
  });

  test("under a minute reads as the short word, and expiring keeps its tone", () => {
    const v = cacheChipView({ ...base, state: "expiring", expiresAt: 30_000 }, 0);
    expect(v?.tone).toBe("expiring");
    expect(v?.label).not.toMatch(/^\d+m$/u);
  });

  test("cold after the grace, and the bridge's cold is trusted at once", () => {
    expect(cacheChipView({ ...base, expiresAt: 0 }, COLD_GRACE_MS)?.tone).toBe("cold");
    expect(cacheChipView({ ...base, state: "cold" }, 0)?.tone).toBe("cold");
  });

  test("an override is marked; unknown or no expiry draws nothing", () => {
    expect(cacheChipView({ ...base, expiresAt: 600_000, overridden: true }, 0)?.overridden).toBe(true);
    expect(cacheChipView({ ...base, state: "unknown" }, 0)).toBeNull();
    expect(cacheChipView(base, 0)).toBeNull();
    expect(cacheChipView(undefined, 0)).toBeNull();
  });
});
