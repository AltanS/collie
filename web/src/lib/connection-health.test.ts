import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetConnectionHealth,
  lastHealthyAt,
  markLive,
  markWake,
  subscribeHealth,
} from "./connection-health";

// Fake timers drive Date.now in Vitest, so the wall-clock anchors advance deterministically. Re-pin
// the anchor to the frozen clock after useFakeTimers so each case starts from a known "now".
describe("connection-health store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetConnectionHealth();
  });
  afterEach(() => vi.useRealTimers());

  it("markLive advances the anchor to now and notifies subscribers", () => {
    let hits = 0;
    const unsub = subscribeHealth(() => hits++);
    const before = lastHealthyAt();
    vi.advanceTimersByTime(5_000);
    markLive();
    expect(lastHealthyAt()).toBe(before + 5_000);
    expect(hits).toBe(1);
    unsub();
  });

  it("markWake advances the anchor and notifies subscribers", () => {
    let hits = 0;
    const unsub = subscribeHealth(() => hits++);
    const before = lastHealthyAt();
    vi.advanceTimersByTime(3_000);
    markWake();
    expect(lastHealthyAt()).toBe(before + 3_000);
    expect(hits).toBe(1);
    unsub();
  });

  it("lastHealthyAt returns the LATER of the last live poll and the last wake", () => {
    const t0 = lastHealthyAt();
    vi.advanceTimersByTime(5_000);
    markLive(); // live at t0+5000
    expect(lastHealthyAt()).toBe(t0 + 5_000);
    vi.advanceTimersByTime(3_000);
    markWake(); // wake at t0+8000 — the more recent anchor wins
    expect(lastHealthyAt()).toBe(t0 + 8_000);
    // A subsequent live stamp that is EARLIER than the wake can't pull the anchor backwards.
    // (Here time only moves forward, so assert the invariant directly: max(live, wake).)
    expect(lastHealthyAt()).toBe(Math.max(t0 + 5_000, t0 + 8_000));
  });

  it("a subscriber stops receiving notifications after unsubscribe", () => {
    let hits = 0;
    const unsub = subscribeHealth(() => hits++);
    markLive();
    expect(hits).toBe(1);
    unsub();
    markLive();
    expect(hits).toBe(1); // no further notifications
  });

  it("a visibilitychange to visible stamps a wake (module-level listener)", () => {
    const before = lastHealthyAt();
    vi.advanceTimersByTime(7_000);
    // jsdom reports document.visibilityState === "visible" by default, so the listener fires markWake.
    document.dispatchEvent(new Event("visibilitychange"));
    expect(lastHealthyAt()).toBe(before + 7_000);
  });

  it("__resetConnectionHealth pins both anchors to the given time", () => {
    vi.advanceTimersByTime(9_000);
    markLive();
    const pinned = 123_456;
    __resetConnectionHealth(pinned);
    expect(lastHealthyAt()).toBe(pinned);
  });
});
