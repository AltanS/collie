import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LIVE_WINDOW_MS, isLive, markLive, resetLiveness, useLive } from "./liveness";

// M46 spec 11: the one fact every send control asks. The stamp is per (host, session, pane), the
// window is wall-clock, and a hook re-renders both when a mark lands and when the mark ages out.

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-07T10:00:00Z"));
  resetLiveness();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("isLive", () => {
  it("is false for a pane the bridge never answered for", () => {
    expect(isLive("w1:p1")).toBe(false);
  });

  it("is true right after a mark, and false once the window has passed", () => {
    markLive("w1:p1");
    expect(isLive("w1:p1")).toBe(true);
    vi.advanceTimersByTime(LIVE_WINDOW_MS);
    expect(isLive("w1:p1")).toBe(true); // the window is inclusive
    vi.advanceTimersByTime(1);
    expect(isLive("w1:p1")).toBe(false);
  });

  it("takes its own window", () => {
    markLive("w1:p1", Date.now() - 4_000);
    expect(isLive("w1:p1", 5_000)).toBe(true);
    expect(isLive("w1:p1", 3_000)).toBe(false);
  });

  it("is per pane and per scope", () => {
    markLive("w1:p1");
    expect(isLive("w1:p2")).toBe(false);
    expect(isLive("w1:p1", LIVE_WINDOW_MS, { host: "minibuch" })).toBe(false);
    markLive("w1:p1", Date.now(), { host: "minibuch" });
    expect(isLive("w1:p1", LIVE_WINDOW_MS, { host: "minibuch" })).toBe(true);
  });

  it("never moves a pane's clock backwards", () => {
    markLive("w1:p1", Date.now());
    markLive("w1:p1", Date.now() - 60_000); // a slow answer landing after a newer one
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

  it("re-renders at the moment the mark ages out, with no other event", () => {
    markLive("w1:p1");
    const { result } = renderHook(() => useLive("w1:p1"));
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(LIVE_WINDOW_MS + 2);
    });
    expect(result.current).toBe(false);
  });

  it("stays live while fresh marks keep arriving", () => {
    const { result } = renderHook(() => useLive("w1:p1"));
    for (let i = 0; i < 5; i++) {
      act(() => markLive("w1:p1"));
      act(() => {
        vi.advanceTimersByTime(LIVE_WINDOW_MS - 1_000);
      });
      expect(result.current).toBe(true);
    }
  });
});
