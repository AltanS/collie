import { renderHook, act } from "@testing-library/react";

import { useIdleLock } from "./use-idle-lock";

// The 30-min idle lock is timestamp-based (measured from the last REAL interaction) so that
// backgrounding/foregrounding a tab — which throttles timers and used to reset the countdown — no
// longer keeps the app unlocked forever. These lock in: activity re-arms, a visibility flip does
// NOT, and returning to a foregrounded tab past the deadline locks immediately.
const IDLE = 1000;

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useIdleLock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
  });
  afterEach(() => {
    vi.useRealTimers();
    setVisibility("visible");
  });

  it("locks after idleMs of no interaction", () => {
    const { result } = renderHook(() => useIdleLock(IDLE));
    expect(result.current.locked).toBe(false);
    act(() => vi.advanceTimersByTime(IDLE));
    expect(result.current.locked).toBe(true);
  });

  it("re-arms on real activity (pointerdown / keydown)", () => {
    const { result } = renderHook(() => useIdleLock(IDLE));
    act(() => vi.advanceTimersByTime(IDLE - 200));
    act(() => document.dispatchEvent(new Event("pointerdown")));
    // Past the ORIGINAL deadline — but activity re-armed it, so still unlocked.
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.locked).toBe(false);
    // Locks idleMs after the last activity.
    act(() => vi.advanceTimersByTime(IDLE));
    expect(result.current.locked).toBe(true);
  });

  it("does NOT re-arm on a visibility flip", () => {
    const { result } = renderHook(() => useIdleLock(IDLE));
    act(() => vi.advanceTimersByTime(IDLE - 100));
    act(() => setVisibility("hidden"));
    act(() => setVisibility("visible"));
    // Visibility isn't activity, so the original deadline still stands and fires.
    act(() => vi.advanceTimersByTime(100));
    expect(result.current.locked).toBe(true);
  });

  it("locks immediately on returning to the foreground past the deadline", () => {
    const { result } = renderHook(() => useIdleLock(IDLE));
    act(() => setVisibility("hidden"));
    // Simulate a throttled background: the wall clock jumps past the deadline WITHOUT the timer
    // firing (setSystemTime advances Date but not the fake timer queue).
    act(() => vi.setSystemTime(Date.now() + IDLE + 500));
    expect(result.current.locked).toBe(false); // no timer fired while backgrounded
    act(() => setVisibility("visible"));
    expect(result.current.locked).toBe(true);
  });

  it("unlock() clears the lock and restarts the countdown", () => {
    const { result } = renderHook(() => useIdleLock(IDLE));
    act(() => vi.advanceTimersByTime(IDLE));
    expect(result.current.locked).toBe(true);
    act(() => result.current.unlock());
    expect(result.current.locked).toBe(false);
    act(() => vi.advanceTimersByTime(IDLE));
    expect(result.current.locked).toBe(true);
  });
});
