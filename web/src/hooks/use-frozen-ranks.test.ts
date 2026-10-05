import { act, renderHook } from "@testing-library/react";

import { paneRowKey } from "@/lib/hosts";
import type { PaneOrder } from "@/lib/pane-order";
import type { AgentView } from "@/lib/types";
import { useFrozenRanks } from "./use-frozen-ranks";

const pane = (paneId: string, lastActiveAt: number): AgentView => ({
  paneId,
  workspaceId: "w1",
  workspaceLabel: "one",
  workspaceNumber: 1,
  tabId: "w1:t1",
  agent: "claude",
  status: "idle",
  cwd: "/home/k/proj",
  focused: false,
  lastActiveAt,
});

const rank = (ranks: ReadonlyMap<string, number>, p: AgentView) => ranks.get(paneRowKey(p));

describe("useFrozenRanks", () => {
  const a = pane("a", 100);
  const b = pane("b", 200);

  it("reads nothing for place order", () => {
    const { result } = renderHook(() => useFrozenRanks("place", [a, b]));
    expect(result.current.ranks.size).toBe(0);
  });

  it("reads once, and holds the reading across a poll", () => {
    const { result, rerender } = renderHook(({ panes }) => useFrozenRanks("activity", panes), {
      initialProps: { panes: [a, b] },
    });
    expect(rank(result.current.ranks, b)).toBe(0);
    rerender({ panes: [pane("a", 900), b] });
    expect(rank(result.current.ranks, b)).toBe(0);
  });

  it("reads again when the order changes, and when asked to", () => {
    const props = (order: PaneOrder, panes: AgentView[]) => ({ order, panes });
    const { result, rerender } = renderHook(({ order, panes }) => useFrozenRanks(order, panes), {
      initialProps: props("place", [a, b]),
    });
    rerender(props("activity", [a, b]));
    expect(rank(result.current.ranks, b)).toBe(0);
    rerender(props("activity", [pane("a", 900), b]));
    expect(rank(result.current.ranks, b)).toBe(0);
    act(() => result.current.reread());
    expect(rank(result.current.ranks, pane("a", 900))).toBe(0);
  });

  it("takes the first reading of a herd that was empty at mount", () => {
    const none: AgentView[] = [];
    const { result, rerender } = renderHook(({ panes }) => useFrozenRanks("activity", panes), {
      initialProps: { panes: none },
    });
    expect(result.current.ranks.size).toBe(0);
    rerender({ panes: [a, b] });
    expect(rank(result.current.ranks, b)).toBe(0);
    // And that was the first reading, not a licence to re-read on every poll.
    rerender({ panes: [pane("a", 900), b] });
    expect(rank(result.current.ranks, b)).toBe(0);
  });

  it("re-reads on a visibility change only when asked", () => {
    const hold = renderHook(({ panes }) => useFrozenRanks("activity", panes), { initialProps: { panes: [a, b] } });
    const watch = renderHook(({ panes }) => useFrozenRanks("activity", panes, { rereadOnVisible: true }), {
      initialProps: { panes: [a, b] },
    });
    const moved = [pane("a", 900), b];
    hold.rerender({ panes: moved });
    watch.rerender({ panes: moved });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(rank(hold.result.current.ranks, b)).toBe(0);
    expect(rank(watch.result.current.ranks, pane("a", 900))).toBe(0);
  });
});
