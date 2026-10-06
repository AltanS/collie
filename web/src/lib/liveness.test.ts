import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEAD_DEBOUNCE_MS,
  LIVE_CAP_MS,
  isLive,
  markAllDead,
  markDead,
  markLive,
  markSavedCopy,
  resetLiveness,
  useLive,
} from "./liveness";

// M46 spec 11, hardened: a pane is live when its LAST read succeeded. Up at once on a success, down
// one second after a failure unless a success lands first, down at once on `offline` and on a saved
// copy, and never live more than 90 s after the last success.

let onLine: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-07T10:00:00Z"));
  resetLiveness();
  onLine = Object.getOwnPropertyDescriptor(navigator, "onLine");
});
afterEach(() => {
  resetLiveness();
  vi.useRealTimers();
  if (onLine) Object.defineProperty(navigator, "onLine", onLine);
  else Reflect.deleteProperty(navigator, "onLine");
});

function setOnLine(value: boolean): void {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => value });
}

describe("isLive", () => {
  it("is false for a pane the bridge never answered for", () => {
    expect(isLive("w1:p1")).toBe(false);
  });

  it("stays live across a quiet stretch with no read, up to the 90 s safety cap", () => {
    markLive("w1:p1");
    vi.advanceTimersByTime(60_000); // far past the old 15 s window: intent-driven polling is slow here
    expect(isLive("w1:p1")).toBe(true);
    vi.advanceTimersByTime(LIVE_CAP_MS - 60_000);
    expect(isLive("w1:p1")).toBe(true); // the cap is inclusive
    vi.advanceTimersByTime(1);
    expect(isLive("w1:p1")).toBe(false);
  });

  it("a failed read takes the pane down after the debounce", () => {
    markLive("w1:p1");
    markDead("w1:p1");
    vi.advanceTimersByTime(DEAD_DEBOUNCE_MS - 1);
    expect(isLive("w1:p1")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isLive("w1:p1")).toBe(false);
  });

  it("one dropped poll followed by a success inside the debounce never goes down", () => {
    markLive("w1:p1");
    markDead("w1:p1");
    vi.advanceTimersByTime(DEAD_DEBOUNCE_MS / 2);
    markLive("w1:p1");
    vi.advanceTimersByTime(DEAD_DEBOUNCE_MS * 2);
    expect(isLive("w1:p1")).toBe(true);
  });

  it("comes back the instant a read succeeds, with no debounce on the way up", () => {
    markLive("w1:p1");
    markDead("w1:p1");
    vi.advanceTimersByTime(DEAD_DEBOUNCE_MS);
    expect(isLive("w1:p1")).toBe(false);
    markLive("w1:p1");
    expect(isLive("w1:p1")).toBe(true);
  });

  it("a saved copy on screen takes the pane down at once", () => {
    markLive("w1:p1");
    markSavedCopy("w1:p1");
    expect(isLive("w1:p1")).toBe(false);
  });

  it("the offline event takes every pane down at once", () => {
    markLive("w1:p1");
    markLive("w1:p2", Date.now(), { host: "minibuch" });
    window.dispatchEvent(new Event("offline"));
    expect(isLive("w1:p1")).toBe(false);
    expect(isLive("w1:p2", { host: "minibuch" })).toBe(false);
  });

  it("markAllDead cancels a pending take-down and clears every pane", () => {
    markLive("w1:p1");
    markDead("w1:p1");
    markAllDead();
    expect(isLive("w1:p1")).toBe(false);
    markLive("w1:p1");
    vi.advanceTimersByTime(DEAD_DEBOUNCE_MS * 2);
    expect(isLive("w1:p1")).toBe(true); // the cancelled timer does not fire later
  });

  it("is not live while the browser says it is offline", () => {
    markLive("w1:p1");
    setOnLine(false);
    expect(isLive("w1:p1")).toBe(false);
    setOnLine(true);
    expect(isLive("w1:p1")).toBe(true);
  });

  it("a failure on a pane that was never live schedules nothing", () => {
    markDead("w1:p1");
    markLive("w1:p1");
    vi.advanceTimersByTime(DEAD_DEBOUNCE_MS * 2);
    expect(isLive("w1:p1")).toBe(true);
  });

  it("is per pane and per scope", () => {
    markLive("w1:p1");
    expect(isLive("w1:p2")).toBe(false);
    expect(isLive("w1:p1", { host: "minibuch" })).toBe(false);
    markLive("w1:p1", Date.now(), { host: "minibuch" });
    expect(isLive("w1:p1", { host: "minibuch" })).toBe(true);
    markDead("w1:p1", { host: "minibuch" });
    vi.advanceTimersByTime(DEAD_DEBOUNCE_MS);
    expect(isLive("w1:p1", { host: "minibuch" })).toBe(false);
    expect(isLive("w1:p1")).toBe(true);
  });

  it("never moves a pane's clock backwards", () => {
    markLive("w1:p1", Date.now());
    markLive("w1:p1", Date.now() - 120_000); // a slow answer landing after a newer one
    expect(isLive("w1:p1")).toBe(true);
  });
});

describe("useLive", () => {
  it("re-renders when a mark lands", () => {
    const { result } = renderHook(() => useLive("w1:p1"));
    expect(result.current).toBe(false);
    act(() => markLive("w1:p1"));
    expect(result.current).toBe(true);
  });

  it("re-renders when a failed read takes the pane down", () => {
    markLive("w1:p1");
    const { result } = renderHook(() => useLive("w1:p1"));
    act(() => markDead("w1:p1"));
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(DEAD_DEBOUNCE_MS);
    });
    expect(result.current).toBe(false);
  });

  it("re-renders at the moment the safety cap runs out, with no other event", () => {
    markLive("w1:p1");
    const { result } = renderHook(() => useLive("w1:p1"));
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(LIVE_CAP_MS + 2);
    });
    expect(result.current).toBe(false);
  });

  it("stays live while fresh marks keep arriving", () => {
    const { result } = renderHook(() => useLive("w1:p1"));
    for (let i = 0; i < 5; i++) {
      act(() => markLive("w1:p1"));
      act(() => {
        vi.advanceTimersByTime(LIVE_CAP_MS - 1_000);
      });
      expect(result.current).toBe(true);
    }
  });
});
