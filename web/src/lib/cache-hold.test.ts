import { cacheHoldKey, holdCacheReadings } from "./cache-hold";
import type { AgentView, PaneCache } from "@/lib/types";

// The rule that stopped the chip blinking. Every case here is a poll arriving in a state the bridge
// really produces (bridge/cache/tracker.ts drops an entry on a failed `stat`, on an unresolved harness
// session id, and — with more than one Herdr session — on another session's poll reaping it).

const NOW = 1_800_000_000_000;

const reading = (over: Partial<PaneCache> = {}): PaneCache => ({
  state: "warm",
  expiresAt: NOW + 12 * 60_000,
  ttlSeconds: 3600,
  ruleId: "claude.subscription",
  confidence: "documented",
  lastRequestAt: NOW - 48 * 60_000,
  ...over,
});

const pane = (paneId: string, cache?: PaneCache, over: Partial<AgentView> = {}): AgentView => {
  const view: AgentView = {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "webapp",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status: "idle",
    cwd: "/home/you/webapp",
    focused: false,
    kind: "agent",
    ...over,
  };
  if (cache !== undefined) view.cache = cache;
  return view;
};

/** Two polls in a row, the way the loader runs them. */
function poll(first: readonly AgentView[], second: readonly AgentView[]) {
  const one = holdCacheReadings(new Map(), first);
  return holdCacheReadings(one.held, second);
}

describe("what the hold carries", () => {
  it("holds the last reading across one poll that arrived with none", () => {
    const warm = reading();
    const out = poll([pane("w1:p1", warm)], [pane("w1:p1")]);
    expect(out.panes[0]!.cache).toEqual(warm);
  });

  it("holds it across a poll that says `unknown`, which says nothing", () => {
    // `unknown` renders as an empty slot exactly like an absent reading (lib/cache-view.ts), so it is
    // the same blink by another name.
    const warm = reading();
    const out = poll([pane("w1:p1", warm)], [pane("w1:p1", reading({ state: "unknown" }))]);
    expect(out.panes[0]!.cache).toEqual(warm);
  });

  it("is replaced by a new reading, never merged with one", () => {
    const fresh = reading({ expiresAt: NOW + 59 * 60_000, state: "expiring" });
    const out = poll([pane("w1:p1", reading())], [pane("w1:p1", fresh)]);
    expect(out.panes[0]!.cache).toEqual(fresh);
  });

  it("is cleared by an explicit cold — only the bridge can see the turn that missed", () => {
    const cold = reading({ state: "cold" });
    const out = poll([pane("w1:p1", reading())], [pane("w1:p1", cold)]);
    expect(out.panes[0]!.cache).toEqual(cold);
    // And the cold reading is what the NEXT empty poll holds, so nothing walks backwards to warm.
    const third = holdCacheReadings(out.held, [pane("w1:p1")]);
    expect(third.panes[0]!.cache).toEqual(cold);
  });

  it("is cleared when the pane id changes — a reading belongs to one pane, not to a slot", () => {
    const out = poll([pane("w1:p1", reading())], [pane("w1:p7")]);
    expect(out.panes[0]!.cache).toBeUndefined();
  });

  it("is cleared when the pane goes away, and is not waiting for it to come back", () => {
    const gone = poll([pane("w1:p1", reading())], []);
    expect(gone.held.size).toBe(0);
    const back = holdCacheReadings(gone.held, [pane("w1:p1")]);
    expect(back.panes[0]!.cache).toBeUndefined();
  });

  it("invents nothing for a pane that never had a reading", () => {
    const out = poll([pane("w1:p1")], [pane("w1:p1")]);
    expect(out.panes[0]!.cache).toBeUndefined();
    expect(out.held.size).toBe(0);
  });

  it("leaves the pane object alone when it has nothing to add", () => {
    const untouched = pane("w1:p1", reading());
    const out = holdCacheReadings(new Map(), [untouched]);
    expect(out.panes[0]).toBe(untouched);
  });
});

describe("the address a reading belongs to", () => {
  it("is machine, session and pane — never the pane id alone", () => {
    // `w1:p1` exists on every machine in a crew and in every widened Herdr session. Keyed by the id
    // alone, one pane's countdown would be held for another's.
    expect(cacheHoldKey(pane("w1:p1", undefined, { host: "attic" }))).not.toBe(
      cacheHoldKey(pane("w1:p1", undefined, { host: "workshop" })),
    );
    expect(cacheHoldKey(pane("w1:p1", undefined, { session: "night" }))).not.toBe(
      cacheHoldKey(pane("w1:p1")),
    );
  });

  it("does not hand one machine's reading to another machine's pane of the same id", () => {
    const attic = pane("w1:p1", reading(), { host: "attic" });
    const workshop = pane("w1:p1", undefined, { host: "workshop" });
    const out = poll([attic], [attic, workshop]);
    expect(out.panes[1]!.cache).toBeUndefined();
  });
});
