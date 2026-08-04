import { renderHook, act } from "@testing-library/react";

import { useIdleLock } from "./use-idle-lock";
import { resetIdleLock } from "@/lib/idle";

// The lock exists for exactly one situation: Collie left OPEN, VISIBLE and untouched past the
// deadline. These pin the two rules that produce that, both of which reverse earlier behaviour —
// a hidden page never locks, and returning to the foreground auto-resumes instead of locking.
const IDLE = 1000;

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useIdleLock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetIdleLock();
    setVisibility("visible");
  });
  afterEach(() => {
    vi.useRealTimers();
    resetIdleLock();
    setVisibility("visible");
  });

  it("locks after idleMs of no interaction while visible", () => {
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
    act(() => vi.advanceTimersByTime(IDLE));
    expect(result.current.locked).toBe(true);
  });

  it("never locks a hidden page, however long it stays hidden", () => {
    const { result } = renderHook(() => useIdleLock(IDLE));
    act(() => setVisibility("hidden"));
    act(() => vi.advanceTimersByTime(IDLE * 10));
    expect(result.current.locked).toBe(false);
  });

  it("returning to the foreground restarts the countdown instead of locking", () => {
    const { result } = renderHook(() => useIdleLock(IDLE));
    act(() => setVisibility("hidden"));
    // A long time away — the old behaviour locked the instant this became visible.
    act(() => vi.setSystemTime(Date.now() + IDLE * 5));
    act(() => setVisibility("visible"));
    expect(result.current.locked).toBe(false);
    // And the fresh deadline runs from the return, not from the last pre-background interaction.
    act(() => vi.advanceTimersByTime(IDLE - 1));
    expect(result.current.locked).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.locked).toBe(true);
  });

  it("auto-resumes when a locked page becomes visible again", () => {
    const { result } = renderHook(() => useIdleLock(IDLE));
    act(() => vi.advanceTimersByTime(IDLE)); // locks while visible
    expect(result.current.locked).toBe(true);
    act(() => setVisibility("hidden"));
    act(() => setVisibility("visible"));
    expect(result.current.locked).toBe(false);
  });

  it("stays locked while visible until resumed — the one case the lock is for", () => {
    const { result } = renderHook(() => useIdleLock(IDLE));
    act(() => vi.advanceTimersByTime(IDLE));
    expect(result.current.locked).toBe(true);
    // No visibility round trip, no unlock() — a tap on the page must not silently dismiss it.
    act(() => document.dispatchEvent(new Event("pointerdown")));
    act(() => vi.advanceTimersByTime(IDLE));
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
