import { act, renderHook } from "@testing-library/react";

import { usePollBusy, POLL_BUSY_THRESHOLD_MS } from "./use-poll-busy";
import { isBusy } from "@/lib/busy";

// Drive useRevalidator/useNavigation directly (hoisted so the vi.mock factory can close over the
// holder), mirroring use-loading-stalled.test — no real router needed to pin loading states.
const h = vi.hoisted(() => ({
  rev: "idle" as "idle" | "loading",
  nav: "idle" as "idle" | "loading" | "submitting",
}));
vi.mock("react-router", () => ({
  useRevalidator: () => ({ state: h.rev }),
  useNavigation: () => ({ state: h.nav }),
}));

const T = POLL_BUSY_THRESHOLD_MS;

describe("usePollBusy — slow-poll busy signal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.rev = "idle";
    h.nav = "idle";
  });
  afterEach(() => {
    vi.useRealTimers();
    // The global afterEach (cleanup) unmounts the hook, whose cleanup effect clears the signal —
    // so no state leaks between tests. (Reset-on-unmount is asserted directly below.)
  });

  it("stays quiet while idle", () => {
    renderHook(() => usePollBusy());
    expect(isBusy()).toBe(false);
    act(() => vi.advanceTimersByTime(T * 2));
    expect(isBusy()).toBe(false);
  });

  it("shows the bar only after the threshold while a poll stays in flight", () => {
    h.rev = "loading";
    renderHook(() => usePollBusy());
    expect(isBusy()).toBe(false); // a slow poll must not flash the bar immediately
    act(() => vi.advanceTimersByTime(T - 1));
    expect(isBusy()).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(isBusy()).toBe(true);
  });

  it("never shows the bar for a fast poll that settles before the threshold", () => {
    h.rev = "loading";
    const { rerender } = renderHook(() => usePollBusy());
    act(() => vi.advanceTimersByTime(T - 200));
    h.rev = "idle"; // settled in time
    act(() => rerender());
    act(() => vi.advanceTimersByTime(1_000)); // past where the original timer would have fired
    expect(isBusy()).toBe(false);
  });

  it("also trips on a slow navigation (revalidator idle)", () => {
    h.nav = "loading"; // e.g. a black-holed pane-open
    renderHook(() => usePollBusy());
    act(() => vi.advanceTimersByTime(T));
    expect(isBusy()).toBe(true);
  });

  it("resets to false once loading stops", () => {
    h.rev = "loading";
    const { rerender } = renderHook(() => usePollBusy());
    act(() => vi.advanceTimersByTime(T));
    expect(isBusy()).toBe(true);
    h.rev = "idle";
    act(() => rerender());
    expect(isBusy()).toBe(false);
  });

  it("clears the signal on unmount so the bar can't get stuck on", () => {
    h.rev = "loading";
    const { unmount } = renderHook(() => usePollBusy());
    act(() => vi.advanceTimersByTime(T));
    expect(isBusy()).toBe(true);
    act(() => unmount());
    expect(isBusy()).toBe(false);
  });
});
