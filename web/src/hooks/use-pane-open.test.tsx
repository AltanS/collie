import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePaneOpen } from "./use-pane-open";
import { OPENING_SHOWN_MS, resetOpenings, useOpeningShown } from "@/lib/pane-opening";
import { fixtureAgents } from "@/test/handlers";

// A tap on a row is PENDING until the pane's read settles: the row shows a mark from 120ms, a second tap on
// it is ignored, and the mark clears on an answer, on a failure's settle, and when the screen goes away.

const down = vi.fn();
vi.mock("@/hooks/use-nav", () => ({ useNav: () => ({ down }) }));

const read = { resolve: () => {} };
vi.mock("@/lib/loaders", () => ({
  prefetchPaneData: vi.fn(
    () =>
      new Promise<void>((resolve) => {
        read.resolve = resolve;
      }),
  ),
}));
// The glide's own wait is lib/glide.ts's business: here it only runs `go`.
vi.mock("@/lib/glide", () => ({
  glideForwardWhenReady: vi.fn((_id: string, _key: string, _ready: Promise<void>, go: () => void) => go()),
}));

const pane = fixtureAgents[0]!;

function mount() {
  return renderHook(() => {
    const open = usePaneOpen({}, undefined, undefined);
    const shown = useOpeningShown(open.glideKeyOf(pane));
    return { open, shown };
  });
}

describe("usePaneOpen: a row that is opening", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    down.mockClear();
  });
  afterEach(() => {
    resetOpenings();
    vi.useRealTimers();
  });

  it("a second tap while the read is out is ignored", () => {
    const { result } = mount();
    act(() => result.current.open.open(pane));
    act(() => result.current.open.open(pane));
    expect(down).toHaveBeenCalledTimes(1);
  });

  it("shows the mark at 120ms and clears it when the read settles", async () => {
    const { result } = mount();
    act(() => result.current.open.open(pane));
    act(() => vi.advanceTimersByTime(OPENING_SHOWN_MS));
    expect(result.current.shown).toBe(true);
    await act(async () => read.resolve());
    expect(result.current.shown).toBe(false);
  });

  it("after the read settles the row takes a tap again", async () => {
    const { result } = mount();
    act(() => result.current.open.open(pane));
    await act(async () => read.resolve());
    act(() => result.current.open.open(pane));
    expect(down).toHaveBeenCalledTimes(2);
  });

  it("leaving the screen clears the mark", () => {
    const { result, unmount } = mount();
    act(() => result.current.open.open(pane));
    act(() => vi.advanceTimersByTime(OPENING_SHOWN_MS));
    unmount();
    const again = renderHook(() => useOpeningShown(result.current.open.glideKeyOf(pane)));
    expect(again.result.current).toBe(false);
  });
});
