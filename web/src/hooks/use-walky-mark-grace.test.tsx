import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WALKY_MARK_GRACE_MS, type WalkyRow } from "@/lib/walky";
import { fixtureWalkyAgent } from "@/test/handlers";

import { useWalkyMarkGrace } from "./use-walky-mark-grace";

// The grace of the held mark: it shows once the OLDEST waiting message has waited WALKY_MARK_GRACE_MS, counted from
// the bridge's time for when it began to wait, and it wakes at that moment with one timer and no tick.

const NOW = Date.parse("2026-11-13T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** A waiting message that began to wait `agoMs` ago. */
function waited(id: string, agoMs: number): WalkyRow {
  const at = NOW - agoMs;
  return { ...fixtureWalkyAgent, id, at, receipt: { ...fixtureWalkyAgent.receipt, id, state: "accepted", reason: "draft present", at } };
}

describe("the held mark's grace", () => {
  it("is 20 seconds, one constant", () => {
    expect(WALKY_MARK_GRACE_MS).toBe(20_000);
  });

  it("stays hidden before the grace, and shows at the exact moment the oldest message reaches it", () => {
    const rows = [waited("a", 5_000)];
    const { result } = renderHook(() => useWalkyMarkGrace(rows));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(14_998));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(2));
    expect(result.current).toBe(true);
  });

  it("shows at once for a message that has waited exactly the grace, and for one that waited longer (a reload)", () => {
    expect(renderHook(() => useWalkyMarkGrace([waited("a", WALKY_MARK_GRACE_MS)])).result.current).toBe(true);
    expect(renderHook(() => useWalkyMarkGrace([waited("b", 90_000)])).result.current).toBe(true);
  });

  it("never shows for a message that goes in inside the grace, and leaves no timer behind", () => {
    let rows: WalkyRow[] = [waited("a", 2_000)];
    const { result, rerender } = renderHook(() => useWalkyMarkGrace(rows));
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(10_000));
    rows = [];
    rerender();
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current).toBe(false);
  });

  it("follows the OLDEST of several messages, and a newer one joining starts no new timer", () => {
    let rows: WalkyRow[] = [waited("a", 5_000), waited("b", 12_000)];
    const { result, rerender } = renderHook(() => useWalkyMarkGrace(rows));
    act(() => vi.advanceTimersByTime(7_000));
    expect(result.current).toBe(false);
    rows = [...rows, waited("c", 0)];
    rerender();
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(1_001));
    expect(result.current).toBe(true);
  });

  it("is right when the tab was in the background: the clock jumped and no timer fired, then the tab returns", () => {
    const { result } = renderHook(() => useWalkyMarkGrace([waited("a", 1_000)]));
    expect(result.current).toBe(false);
    // The browser froze the timer; a minute passes on the clock.
    vi.setSystemTime(NOW + 60_000);
    expect(result.current).toBe(false);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current).toBe(true);
  });

  it("draws nothing when nothing waits", () => {
    const { result } = renderHook(() => useWalkyMarkGrace([]));
    expect(result.current).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
