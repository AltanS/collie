import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { paneRowKey } from "./hosts";
import {
  __reloadPins,
  currentPins,
  dropPin,
  MAX_PINS,
  pinMatcher,
  setPinned,
  usePins,
} from "./pins";
import type { AgentView } from "./types";

// The pins store (ADR 0070): its own module store under `collie:pins:v1`, keyed by the row and the
// workspace NAME, bounded at 32 records, and written on the operator's own acts only.

const KEY = "collie:pins:v1";

function pane(id: string, space: string, extra: Partial<AgentView> = {}): AgentView {
  return {
    paneId: id,
    workspaceId: `w-${space}`,
    workspaceLabel: space,
    workspaceNumber: 1,
    tabId: `${id}:t1`,
    agent: "claude",
    status: "idle",
    cwd: `/home/you/${space}`,
    focused: false,
    ...extra,
  };
}

const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "null");

describe("pins", () => {
  it("pins a pane and unpins it again, in storage and in memory", () => {
    const orchestrator = pane("w1:p1", "collie");
    const isPinned = () => pinMatcher(currentPins())(orchestrator);
    expect(isPinned()).toBe(false);

    setPinned(orchestrator, true, [orchestrator], 100);
    expect(isPinned()).toBe(true);
    expect(stored()).toEqual([{ row: paneRowKey(orchestrator), space: "collie", at: 100 }]);

    setPinned(orchestrator, false, [orchestrator], 200);
    expect(isPinned()).toBe(false);
    expect(stored()).toEqual([]);
  });

  it("re-renders a reader on every write, the useSyncExternalStore way", () => {
    const a = pane("w1:p1", "collie");
    const { result } = renderHook(() => usePins());
    expect(result.current).toEqual([]);
    act(() => setPinned(a, true, [a], 5));
    expect(result.current).toHaveLength(1);
    act(() => setPinned(a, false, [a], 6));
    expect(result.current).toHaveLength(0);
  });

  it("applies a pin only while the pane sits in a workspace of the pinned name", () => {
    const a = pane("w1:p1", "collie");
    setPinned(a, true, [a], 1);
    // The same row key in another workspace (Herdr reused the id, or a new tmux server counts from
    // %0 again) is a different pane: the name is the guard.
    const reused = pane("w1:p1", "webapp");
    expect(pinMatcher(currentPins())(a)).toBe(true);
    expect(pinMatcher(currentPins())(reused)).toBe(false);
  });

  it("drops a record whose row key now names a live pane in another workspace, on the next write", () => {
    const old = pane("w1:p1", "collie");
    setPinned(old, true, [old], 1);
    // The id came back in another workspace. The poll changes nothing: absence and reuse are only
    // acted on by the operator's next write.
    const reused = pane("w1:p1", "webapp");
    const other = pane("w2:p1", "docs");
    expect(currentPins()).toHaveLength(1);
    setPinned(other, true, [reused, other], 2);
    expect(currentPins().map((p) => p.space)).toEqual(["docs"]);
  });

  it("keeps a dormant pin: absence never prunes", () => {
    const gone = pane("w1:p1", "collie");
    setPinned(gone, true, [gone], 1);
    // A restart passes through a listing without the pane. The next write keeps its pin.
    const other = pane("w2:p1", "docs");
    setPinned(other, true, [other], 2);
    expect(currentPins().map((p) => p.space).toSorted()).toEqual(["collie", "docs"]);
  });

  it(`bounds the store at ${MAX_PINS} records, evicting the oldest dormant record first`, () => {
    const live = Array.from({ length: 20 }, (_, i) => pane(`w1:p${i}`, "live"));
    const dormant = Array.from({ length: 20 }, (_, i) => pane(`w2:p${i}`, "gone"));
    // Twenty dormant pins made first (so they are the oldest), then twenty live ones, each write
    // seeing only the live herd.
    let now = 0;
    for (const p of dormant) setPinned(p, true, [], ++now);
    for (const p of live) setPinned(p, true, live, ++now);
    const kept = currentPins();
    expect(kept).toHaveLength(MAX_PINS);
    // All twenty live pins survive; eight dormant ones did not, the oldest of them.
    expect(kept.filter((p) => p.space === "live")).toHaveLength(20);
    const keptDormant = kept.filter((p) => p.space === "gone").map((p) => p.row);
    expect(keptDormant).toEqual(dormant.slice(8).map((p) => paneRowKey(p)));
  });

  it("evicts the oldest live record once no dormant one is left, and never the one just pinned", () => {
    const herd = Array.from({ length: MAX_PINS + 1 }, (_, i) => pane(`w1:p${i}`, "live"));
    herd.forEach((p, i) => setPinned(p, true, herd, 1000 - i)); // each new pin is OLDER by its stamp
    const rows = currentPins().map((p) => p.row);
    expect(rows).toHaveLength(MAX_PINS);
    // The last pin carries the oldest stamp and still stays: the bound never evicts the act itself.
    expect(rows).toContain(paneRowKey(herd[MAX_PINS]!));
    expect(rows).not.toContain(paneRowKey(herd[MAX_PINS - 1]!));
  });

  it("drops the pin when the pane is closed from Collie, and writes nothing when there was none", () => {
    const a = pane("w1:p1", "collie");
    const b = pane("w2:p1", "docs");
    setPinned(a, true, [a, b], 1);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    dropPin(b);
    expect(setItem).not.toHaveBeenCalled();
    dropPin(a);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(currentPins()).toEqual([]);
    setItem.mockRestore();
  });

  it("survives a malformed value: junk, a non-array, and bad records all read as the good ones", () => {
    const a = pane("w1:p1", "collie");
    for (const junk of ["{not json", '"a string"', '{"row":"x"}', "null", "42"]) {
      localStorage.setItem(KEY, junk);
      __reloadPins();
      expect(currentPins()).toEqual([]);
      expect(pinMatcher(currentPins())(a)).toBe(false);
    }
    localStorage.setItem(
      KEY,
      JSON.stringify([
        { row: paneRowKey(a), space: "collie", at: 3 },
        { row: 7, space: "collie", at: 3 },
        { row: "x", at: 3 },
        "nope",
        { row: paneRowKey(a), space: "collie", at: 4 },
      ]),
    );
    __reloadPins();
    expect(currentPins()).toEqual([{ row: paneRowKey(a), space: "collie", at: 3 }]);
    expect(pinMatcher(currentPins())(a)).toBe(true);
  });

  it("never writes on a read: loading, subscribing and matching leave storage alone", () => {
    const a = pane("w1:p1", "collie");
    localStorage.setItem(KEY, "{not json");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    __reloadPins();
    const { rerender } = renderHook(() => pinMatcher(usePins())(a));
    rerender();
    rerender();
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    // The junk is still there: a read repairs nothing.
    expect(localStorage.getItem(KEY)).toBe("{not json");
    setItem.mockRestore();
    removeItem.mockRestore();
  });

  it("keys by host and session too, so a crew's two w1:p1 panes are two pins", () => {
    const lead = pane("w1:p1", "collie", { host: "bluefin" });
    const peer = pane("w1:p1", "collie", { host: "workshop" });
    setPinned(lead, true, [lead, peer], 1);
    expect(pinMatcher(currentPins())(lead)).toBe(true);
    expect(pinMatcher(currentPins())(peer)).toBe(false);
  });
});
