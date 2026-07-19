import { act, renderHook } from "@testing-library/react";

import { CONNECTION_LOST_MS, useConnectionLost } from "./use-connection-lost";
import { __resetConnectionHealth, markLive, markWake } from "@/lib/connection-health";

// Wall-clock derived, so fake timers (which also advance Date.now in Vitest) drive both the countdown
// and the elapsed-time comparison the hook reads. Escalation now anchors on the SHARED
// lib/connection-health store, so we re-pin its anchor to the frozen clock after useFakeTimers.
describe("useConnectionLost", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetConnectionHealth();
  });
  afterEach(() => vi.useRealTimers());

  it("stays false while the connection is healthy", () => {
    const { result } = renderHook(({ c }) => useConnectionLost(c), {
      initialProps: { c: false },
    });
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS * 2));
    expect(result.current).toBe(false);
  });

  it("flips true only after the threshold of continuous disconnection", () => {
    const { result } = renderHook(({ c }) => useConnectionLost(c), {
      initialProps: { c: true },
    });
    expect(result.current).toBe(false); // a slow moment isn't yet an outage
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS - 1));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it("does not trip on a brief blip that recovers before the threshold", () => {
    const { result, rerender } = renderHook(({ c }) => useConnectionLost(c), {
      initialProps: { c: true },
    });
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS - 3_000));
    rerender({ c: false }); // recovered in time
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS));
    expect(result.current).toBe(false);
  });

  it("resets to false the moment the connection recovers", () => {
    const { result, rerender } = renderHook(({ c }) => useConnectionLost(c), {
      initialProps: { c: true },
    });
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS));
    expect(result.current).toBe(true);
    rerender({ c: false });
    expect(result.current).toBe(false);
  });

  it("honours a custom threshold", () => {
    const { result } = renderHook(({ c }) => useConnectionLost(c, 5_000), {
      initialProps: { c: true },
    });
    act(() => vi.advanceTimersByTime(4_999));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  // The shared-clock guarantees — the whole point of the module store: independent consumers (the
  // header pill, the outage banner, the in-pane header) read the SAME anchor, so they cannot diverge.
  it("two independent consumers escalate together (shared clock — cannot diverge)", () => {
    const a = renderHook(({ c }) => useConnectionLost(c), { initialProps: { c: true } });
    const b = renderHook(({ c }) => useConnectionLost(c), { initialProps: { c: true } });
    expect(a.result.current).toBe(false);
    expect(b.result.current).toBe(false);
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS));
    expect(a.result.current).toBe(true);
    expect(b.result.current).toBe(true);
  });

  it("a consumer mounted mid-outage escalates on the SHARED clock, not a fresh one", () => {
    // This is the reproduced on-device bug: the pill remounts on a route change and, with the OLD
    // per-instance clock, restarted its own 15s — sitting amber while the persistent banner had gone
    // red. With the shared anchor, a consumer that appears 10s into an outage escalates WITH the rest.
    const a = renderHook(({ c }) => useConnectionLost(c), { initialProps: { c: true } });
    act(() => vi.advanceTimersByTime(10_000));
    expect(a.result.current).toBe(false);
    const b = renderHook(({ c }) => useConnectionLost(c), { initialProps: { c: true } });
    expect(b.result.current).toBe(false);
    act(() => vi.advanceTimersByTime(5_000)); // t = 15s from outage start
    expect(a.result.current).toBe(true);
    expect(b.result.current).toBe(true); // did NOT restart its own clock on mount
  });

  it("a live poll (markLive) resets the escalation clock to the moment of success", () => {
    const { result } = renderHook(({ c }) => useConnectionLost(c), { initialProps: { c: true } });
    act(() => vi.advanceTimersByTime(10_000));
    expect(result.current).toBe(false);
    act(() => markLive()); // a good poll landed 10s in → the anchor moves to now
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS - 1));
    expect(result.current).toBe(false); // the full threshold must elapse FROM the success
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it("a wake (markWake) grants a fresh grace window mid-outage", () => {
    const { result } = renderHook(({ c }) => useConnectionLost(c), { initialProps: { c: true } });
    act(() => vi.advanceTimersByTime(14_000)); // almost escalated
    expect(result.current).toBe(false);
    act(() => markWake()); // phone woke → fresh grace from here, not an instant red flash
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS - 1));
    expect(result.current).toBe(false); // the pre-wake timer would have fired; the wake pushed it back
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  // STICKY escalation — a mid-outage app switch (visibilitychange → markWake) must NOT downgrade an
  // already-red "not connected" back to amber "reconnecting…" for another window.
  it("(a) once escalated, a wake keeps it lost immediately — no fresh grace on a mid-outage app switch", () => {
    const { result } = renderHook(({ c }) => useConnectionLost(c), { initialProps: { c: true } });
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS)); // escalate → latched
    expect(result.current).toBe(true);
    act(() => markWake()); // switch away + back mid-outage; old code reset the anchor → downgrade
    expect(result.current).toBe(true); // STILL lost, in the very next sample — latch dropped the grace
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS)); // …and stays lost while it keeps failing
    expect(result.current).toBe(true);
  });

  it("(b) a wake BEFORE escalation still grants fresh grace (a healthy-network resume never flashes red)", () => {
    const { result } = renderHook(({ c }) => useConnectionLost(c), { initialProps: { c: true } });
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS - 2_000)); // 13s — not yet lost, not yet latched
    expect(result.current).toBe(false);
    act(() => markWake()); // resume from sleep on a healthy network, before any red UI ever showed
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS - 1)); // grace restarts from the wake
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1)); // a full window AFTER the wake
    expect(result.current).toBe(true);
  });

  it("(c) recovery via markLive clears the latch; a later wake does not resurrect the escalation", () => {
    const { result } = renderHook(({ c }) => useConnectionLost(c), { initialProps: { c: true } });
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS)); // escalate → latched
    expect(result.current).toBe(true);
    act(() => markLive()); // a good poll lands: freshens the anchor AND clears the latch
    expect(result.current).toBe(false); // recovered immediately
    act(() => markWake()); // a wake AFTER recovery must not bring red back
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS - 1)); // full grace still applies from recovery
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1)); // it CAN escalate again if failure genuinely persists
    expect(result.current).toBe(true);
  });
});
