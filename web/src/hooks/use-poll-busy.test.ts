import { act, renderHook } from "@testing-library/react";

import { usePollBusy, NAV_BUSY_THRESHOLD_MS, POLL_BUSY_THRESHOLD_MS } from "./use-poll-busy";
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

const NAV_T = NAV_BUSY_THRESHOLD_MS;
const POLL_T = POLL_BUSY_THRESHOLD_MS;

describe("usePollBusy — two independent thresholds (nav vs. background poll)", () => {
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
    act(() => vi.advanceTimersByTime(POLL_T * 2));
    expect(isBusy()).toBe(false);
  });

  it("a navigation past its (short) threshold shows the bar", () => {
    h.nav = "loading"; // e.g. a black-holed pane-open
    renderHook(() => usePollBusy());
    expect(isBusy()).toBe(false); // must not flash immediately
    act(() => vi.advanceTimersByTime(NAV_T - 1));
    expect(isBusy()).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(isBusy()).toBe(true);
  });

  it("a background revalidation between the nav and poll thresholds does NOT show the bar", () => {
    h.rev = "loading"; // on-device: routinely 0.5-1.5s over the reverse proxy
    renderHook(() => usePollBusy());
    act(() => vi.advanceTimersByTime(NAV_T)); // past the (shorter) nav threshold
    expect(isBusy()).toBe(false); // but a poll gets the longer, ambient threshold
    act(() => vi.advanceTimersByTime(POLL_T - NAV_T - 1));
    expect(isBusy()).toBe(false);
  });

  it("a background revalidation past its (long) threshold shows the bar", () => {
    h.rev = "loading";
    renderHook(() => usePollBusy());
    act(() => vi.advanceTimersByTime(POLL_T - 1));
    expect(isBusy()).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(isBusy()).toBe(true);
  });

  it("never shows the bar for a fast poll that settles before its threshold", () => {
    h.rev = "loading";
    const { rerender } = renderHook(() => usePollBusy());
    act(() => vi.advanceTimersByTime(POLL_T - 200));
    h.rev = "idle"; // settled in time
    act(() => rerender());
    act(() => vi.advanceTimersByTime(5_000)); // past where the original timer would have fired
    expect(isBusy()).toBe(false);
  });

  it("resets to false once loading stops", () => {
    h.rev = "loading";
    const { rerender } = renderHook(() => usePollBusy());
    act(() => vi.advanceTimersByTime(POLL_T));
    expect(isBusy()).toBe(true);
    h.rev = "idle";
    act(() => rerender());
    expect(isBusy()).toBe(false);
  });

  it("clears the signal on unmount so the bar can't get stuck on", () => {
    h.rev = "loading";
    const { unmount } = renderHook(() => usePollBusy());
    act(() => vi.advanceTimersByTime(POLL_T));
    expect(isBusy()).toBe(true);
    act(() => unmount());
    expect(isBusy()).toBe(false);
  });

  describe("overlapping nav + poll", () => {
    it("shows once either crosses its threshold, and clears only once BOTH are idle", () => {
      h.nav = "loading";
      h.rev = "loading";
      const { rerender } = renderHook(() => usePollBusy());

      // Nav crosses its (short) threshold first — bar shows even though the poll is still under
      // its own, longer threshold.
      act(() => vi.advanceTimersByTime(NAV_T));
      expect(isBusy()).toBe(true);

      // The poll now also crosses its threshold while nav is still loading too — stays shown.
      act(() => vi.advanceTimersByTime(POLL_T - NAV_T));
      expect(isBusy()).toBe(true);

      // Nav settles, but the poll is still loading (and already past its own threshold) — stays
      // shown: clearing ONE past-threshold signal is not enough.
      h.nav = "idle";
      act(() => rerender());
      expect(isBusy()).toBe(true);

      // Only once the poll settles too does the bar clear.
      h.rev = "idle";
      act(() => rerender());
      expect(isBusy()).toBe(false);
    });
  });
});
