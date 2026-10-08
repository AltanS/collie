import { act, renderHook } from "@testing-library/react";

import {
  CONNECTION_LOST_MS,
  TROUBLE_MS,
  useConnectionLost,
  useConnectionTrouble,
} from "./use-connection-lost";
import {
  __resetConnectionHealth,
  beginLongUpload,
  endLongUpload,
  isLostLatched,
  markLive,
  markWake,
  noteNetworkFailure,
  noteReadStart,
  noteServerFailure,
  WAKE_STRIKE_MS,
} from "@/lib/connection-health";
import { RETRY_MS } from "@/hooks/use-polling";
import { POLL_TIMEOUT_MS } from "@/lib/api";

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

// The 4s ambient TROUBLE threshold — the amber bar + the galloping dog. Same shared anchor as the 15s
// lost escalation, just shorter and NON-latching, so a single slow poll never flashes a bar.
// A voice clip going up a phone's uplink makes every poll behind it look stalled. That is the app's
// own traffic, not an outage, so neither threshold may escalate while one is in flight — the beta
// report this suppression exists for was an amber "Reconnecting…" bar during a perfectly good upload.
describe("a long upload the operator started", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetConnectionHealth();
  });
  afterEach(() => vi.useRealTimers());

  it("suppresses BOTH thresholds for as long as the upload is in flight", () => {
    const { result } = renderHook(() => ({
      lost: useConnectionLost(true),
      trouble: useConnectionTrouble(true),
    }));
    act(() => beginLongUpload());
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS * 4));

    expect(result.current.trouble).toBe(false);
    expect(result.current.lost).toBe(false);
    // And nothing latched, so the release below cannot come back already-red.
    expect(isLostLatched()).toBe(false);
  });

  it("releasing grants a fresh window rather than escalating on the anchor it went stale on", () => {
    const { result } = renderHook(() => useConnectionTrouble(true));
    act(() => beginLongUpload());
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS * 4));
    act(() => endLongUpload());

    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(TROUBLE_MS - 1));
    expect(result.current).toBe(false);
    // The link really is not answering — a fresh window later, it says so.
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it("counts, so one pane finishing does not un-suppress another still uploading", () => {
    const { result } = renderHook(() => useConnectionTrouble(true));
    act(() => beginLongUpload());
    act(() => beginLongUpload());
    act(() => endLongUpload());
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS * 2));
    expect(result.current).toBe(false);

    act(() => endLongUpload());
    act(() => vi.advanceTimersByTime(TROUBLE_MS));
    expect(result.current).toBe(true);
  });
});

describe("useConnectionTrouble", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetConnectionHealth();
  });
  afterEach(() => vi.useRealTimers());

  it("stays false while healthy", () => {
    const { result } = renderHook(({ c }) => useConnectionTrouble(c), { initialProps: { c: false } });
    act(() => vi.advanceTimersByTime(TROUBLE_MS * 4));
    expect(result.current).toBe(false);
  });

  it("flips true only after TROUBLE_MS of continuous not-live — a single slow beat isn't yet trouble", () => {
    const { result } = renderHook(({ c }) => useConnectionTrouble(c), { initialProps: { c: true } });
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(TROUBLE_MS - 1));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it("never latches — observing trouble does NOT set the sticky escalation latch", () => {
    const { result } = renderHook(({ c }) => useConnectionTrouble(c), { initialProps: { c: true } });
    act(() => vi.advanceTimersByTime(TROUBLE_MS));
    expect(result.current).toBe(true);
    expect(isLostLatched()).toBe(false); // only the 15s lost threshold latches
    // Because it never latched, a pre-lost wake still grants fresh grace: trouble drops on the wake…
    act(() => markWake());
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(TROUBLE_MS)); // …and only returns after another full window
    expect(result.current).toBe(true);
  });

  it("runs in lockstep with useConnectionLost off the ONE clock: amber at 4s, red at 15s", () => {
    const trouble = renderHook(({ c }) => useConnectionTrouble(c), { initialProps: { c: true } });
    const lost = renderHook(({ c }) => useConnectionLost(c), { initialProps: { c: true } });
    act(() => vi.advanceTimersByTime(TROUBLE_MS)); // 4s
    expect(trouble.result.current).toBe(true); // amber
    expect(lost.result.current).toBe(false); // not red yet
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS - TROUBLE_MS)); // 15s total
    expect(trouble.result.current).toBe(true);
    expect(lost.result.current).toBe(true); // red — and trouble is still true beneath it
  });
});

// M46 pass 3: a failed herd read proves the outage without the clock. The muted dog and the red strip
// flip on the SAME failure that turns the screen into the saved copy.
describe("an outage a failed read already proved", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetConnectionHealth();
  });
  afterEach(() => vi.useRealTimers());

  it("a read that got no answer reaches both thresholds at once", () => {
    const lost = renderHook(({ c }) => useConnectionLost(c), { initialProps: { c: true } });
    const trouble = renderHook(({ c }) => useConnectionTrouble(c), { initialProps: { c: true } });
    expect(lost.result.current).toBe(false);
    act(() => noteNetworkFailure());
    expect(lost.result.current).toBe(true);
    expect(trouble.result.current).toBe(true);
  });

  it("one 5xx is not enough, the second in a row is", () => {
    const { result } = renderHook(({ c }) => useConnectionLost(c), { initialProps: { c: true } });
    act(() => noteServerFailure());
    expect(result.current).toBe(false);
    act(() => noteServerFailure());
    expect(result.current).toBe(true);
  });

  it("says nothing while nothing is connecting, and a live answer takes it back", () => {
    const { result, rerender } = renderHook(({ c }) => useConnectionLost(c), { initialProps: { c: false } });
    act(() => noteNetworkFailure());
    expect(result.current).toBe(false);
    rerender({ c: true });
    expect(result.current).toBe(true);
    act(() => markLive());
    expect(result.current).toBe(false);
  });
});

// 2026-10-08: right after a wake the first herd read with no answer is ONE STRIKE, not the outage. A
// phone that reaches the bridge through a Tailscale relay needs a moment after it returns from the
// background, and its first poll often gets no answer although nothing is wrong. The retry 0.5s later
// (hooks/use-polling.ts RETRY_MS) decides. Each `read` below is one herd read as lib/api.ts
// `fetchSnapshot` makes it: stamped at its start, counted at its failure.
describe("right after a wake, one read with no answer is one strike", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetConnectionHealth();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const failedRead = () => {
    noteReadStart();
    noteNetworkFailure();
  };
  const hidden = (yes: boolean) =>
    vi.spyOn(document, "visibilityState", "get").mockReturnValue(yes ? "hidden" : "visible");

  it("(a) awake and visible, one read with no answer is red at once, as before", () => {
    const { result } = renderHook(({ c }) => useConnectionLost(c), { initialProps: { c: true } });
    act(() => failedRead());
    expect(result.current).toBe(true);
  });

  it("(a) a wake long past grants nothing: a read started after the window is red at once", () => {
    const { result } = renderHook(({ c }) => useConnectionLost(c), { initialProps: { c: true } });
    act(() => markWake());
    act(() => vi.advanceTimersByTime(WAKE_STRIKE_MS));
    act(() => failedRead());
    expect(result.current).toBe(true);
  });

  it("(b) a wake, one read with no answer: no red; the retry gets no answer either: red at once", () => {
    const { result } = renderHook(({ c }) => useConnectionLost(c), { initialProps: { c: true } });
    act(() => markWake());
    act(() => failedRead());
    expect(result.current).toBe(false);
    expect(isLostLatched()).toBe(false);
    act(() => vi.advanceTimersByTime(RETRY_MS));
    act(() => failedRead());
    expect(result.current).toBe(true);
  });

  it("(b) a wake, one read with no answer, the retry answers: never red", () => {
    const { result, rerender } = renderHook(({ c }) => useConnectionLost(c), { initialProps: { c: true } });
    const seen: boolean[] = [];
    act(() => markWake());
    act(() => failedRead());
    seen.push(result.current);
    act(() => vi.advanceTimersByTime(RETRY_MS));
    act(() => markLive());
    rerender({ c: false });
    seen.push(result.current);
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS * 2));
    seen.push(result.current);
    expect(seen).toEqual([false, false, false]);
    // The live answer spent the strike's reason: the next failure, outside the window, is red at once.
    rerender({ c: true });
    act(() => failedRead());
    expect(result.current).toBe(true);
  });

  it("(b) the wake's own read started in the window and ran out of time after it: still one strike", () => {
    const { result } = renderHook(({ c }) => useConnectionLost(c), { initialProps: { c: true } });
    act(() => markWake());
    act(() => noteReadStart());
    act(() => vi.advanceTimersByTime(POLL_TIMEOUT_MS));
    act(() => noteNetworkFailure());
    expect(result.current).toBe(false);
  });

  it("(b) a read in flight across the wake is one strike, however long it then took", () => {
    // The phone slept with the read in flight; the hook mounts on the return, as the screen does.
    act(() => noteReadStart());
    act(() => vi.advanceTimersByTime(60_000));
    act(() => markWake());
    const { result } = renderHook(({ c }) => useConnectionLost(c), { initialProps: { c: true } });
    act(() => vi.advanceTimersByTime(WAKE_STRIKE_MS * 2));
    act(() => noteNetworkFailure());
    expect(result.current).toBe(false);
    act(() => failedRead());
    expect(result.current).toBe(true);
  });

  it("(b) every wake grants its own strike, and only one", () => {
    act(() => markWake());
    act(() => failedRead());
    expect(isLostLatched()).toBe(false);
    act(() => vi.advanceTimersByTime(60_000));
    act(() => markWake());
    act(() => failedRead());
    expect(isLostLatched()).toBe(false);
    act(() => failedRead());
    expect(isLostLatched()).toBe(true);
  });

  it("(c) a read started while the page was hidden, failing after the return: no red alone", () => {
    const { result } = renderHook(({ c }) => useConnectionLost(c), { initialProps: { c: true } });
    hidden(true);
    act(() => noteReadStart());
    hidden(false);
    act(() => vi.advanceTimersByTime(POLL_TIMEOUT_MS));
    act(() => noteNetworkFailure());
    expect(result.current).toBe(false);
    act(() => failedRead());
    expect(result.current).toBe(true);
  });

  it("(c) a read that fails while the page is hidden latches nothing alone", () => {
    act(() => noteReadStart());
    hidden(true);
    act(() => noteNetworkFailure());
    expect(isLostLatched()).toBe(false);
  });

  it("(d) the 5xx rule is unchanged right after a wake: the second in a row is red", () => {
    const { result } = renderHook(({ c }) => useConnectionLost(c), { initialProps: { c: true } });
    act(() => markWake());
    act(() => noteServerFailure());
    expect(result.current).toBe(false);
    act(() => noteServerFailure());
    expect(result.current).toBe(true);
  });

  it("(e) the long-upload rule is unchanged: nothing escalates while the operator uploads", () => {
    const { result } = renderHook(({ c }) => useConnectionLost(c), { initialProps: { c: true } });
    act(() => beginLongUpload());
    act(() => failedRead());
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS * 2));
    expect(result.current).toBe(false);
    act(() => endLongUpload());
    // The failure before the upload ended was proof: the latch stands once the upload is done.
    expect(result.current).toBe(true);
  });
});
