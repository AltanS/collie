import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { intervalFor, type PollIntent, RETRY_MS } from "@/hooks/use-polling";

import { POLL_TIMEOUT_MS } from "./api";
import {
  __resetConnectionHealth,
  CONNECTION_LOST_MS,
  effectiveAnchor,
  isLostLatched,
  lastHealthyAt,
  latchLost,
  markLive,
  markWake,
  NETWORK_LATCH_MS,
  noteNetworkFailure,
  strikeHolds,
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

  it("__resetConnectionHealth notifies subscribers, same as markLive/markWake/latchLost", () => {
    // Pins the fix: a reset used to mutate the store silently, so a subscriber (a component driven
    // by useConnectionHealth/useSyncExternalStore) never repainted until its own once-per-mount
    // setTimeout happened to re-check — up to CONNECTION_LOST_MS later, not right after the reset.
    let hits = 0;
    const unsub = subscribeHealth(() => hits++);
    __resetConnectionHealth(123_456);
    expect(hits).toBe(1);
    unsub();
  });

  // Sticky-escalation latch — the fix for a mid-outage app switch downgrading red → amber.
  describe("sticky-escalation latch", () => {
    it("latchLost sets the latch and notifies once; repeat calls are no-ops", () => {
      let hits = 0;
      const unsub = subscribeHealth(() => hits++);
      expect(isLostLatched()).toBe(false);
      latchLost();
      expect(isLostLatched()).toBe(true);
      expect(hits).toBe(1);
      latchLost(); // idempotent — already latched, so no state change and no notify
      expect(hits).toBe(1);
      unsub();
    });

    it("while latched, effectiveAnchor ignores the wake grace (a wake can't move it)", () => {
      const t0 = lastHealthyAt();
      vi.advanceTimersByTime(20_000); // lastLiveAt/lastWakeAt stay at t0 (no markLive/markWake yet)
      latchLost(); // escalated: lastLiveAt (t0) is already stale
      expect(effectiveAnchor()).toBe(t0); // == lastLiveAt
      markWake(); // a mid-outage app switch stamps a wake…
      expect(effectiveAnchor()).toBe(t0); // …but effectiveAnchor stays on the stale live anchor
      expect(lastHealthyAt()).toBe(t0 + 20_000); // the wake WAS recorded — just excluded while latched
    });

    it("effectiveAnchor DOES include the wake grace when NOT latched", () => {
      const t0 = lastHealthyAt();
      vi.advanceTimersByTime(6_000);
      markWake();
      expect(isLostLatched()).toBe(false);
      expect(effectiveAnchor()).toBe(t0 + 6_000); // max(live, wake) — grace applies
    });

    it("markLive clears the latch (recovery de-escalates everything together)", () => {
      latchLost();
      expect(isLostLatched()).toBe(true);
      vi.advanceTimersByTime(5_000);
      markLive();
      expect(isLostLatched()).toBe(false);
      expect(effectiveAnchor()).toBe(lastHealthyAt()); // wake grace back in play
    });

    it("markWake does NOT clear the latch", () => {
      latchLost();
      markWake();
      expect(isLostLatched()).toBe(true);
    });

    it("__resetConnectionHealth clears the latch", () => {
      latchLost();
      expect(isLostLatched()).toBe(true);
      __resetConnectionHealth();
      expect(isLostLatched()).toBe(false);
    });
  });

  // The pane and Chat reads fail in the same poll as the herd read, in either order. Whichever lands
  // first, neither may draw the saved copy over the strike the herd read takes (2026-10-08, always
  // since 2026-10-29): the herd read decides.
  describe("strikeHolds", () => {
    it("holds before the herd read has failed and after it took the strike", () => {
      expect(strikeHolds()).toBe(true);
      noteNetworkFailure();
      expect(isLostLatched()).toBe(false);
      expect(strikeHolds()).toBe(true);
    });

    it("stops once a later read with no answer latches", () => {
      noteNetworkFailure();
      vi.advanceTimersByTime(NETWORK_LATCH_MS);
      noteNetworkFailure();
      expect(isLostLatched()).toBe(true);
      expect(strikeHolds()).toBe(false);
    });

    // A read that fails at once (the phone moving between Wi-Fi and the mobile network) fails its retry
    // 0.5s later too: failures that close together prove nothing until no live answer has come for
    // NETWORK_LATCH_MS (2026-10-29).
    it("failures close to the last live answer latch nothing; the first past NETWORK_LATCH_MS does", () => {
      vi.advanceTimersByTime(30_000);
      markLive();
      for (let t = 0; t < NETWORK_LATCH_MS - 500; t += 500) {
        noteNetworkFailure();
        vi.advanceTimersByTime(500);
      }
      noteNetworkFailure();
      expect(isLostLatched()).toBe(false);
      expect(strikeHolds()).toBe(true);
      vi.advanceTimersByTime(500);
      noteNetworkFailure();
      expect(isLostLatched()).toBe(true);
    });

    it("the window runs from a wake too", () => {
      vi.advanceTimersByTime(60_000);
      markWake();
      noteNetworkFailure();
      vi.advanceTimersByTime(NETWORK_LATCH_MS - 1);
      noteNetworkFailure();
      expect(isLostLatched()).toBe(false);
      vi.advanceTimersByTime(1);
      noteNetworkFailure();
      expect(isLostLatched()).toBe(true);
    });

    it("a live answer gives the strike back", () => {
      noteNetworkFailure();
      vi.advanceTimersByTime(NETWORK_LATCH_MS);
      markLive();
      vi.advanceTimersByTime(NETWORK_LATCH_MS);
      noteNetworkFailure();
      expect(isLostLatched()).toBe(false);
      expect(strikeHolds()).toBe(true);
    });

    it("a wake gives the strike back", () => {
      noteNetworkFailure();
      vi.advanceTimersByTime(NETWORK_LATCH_MS);
      markWake();
      vi.advanceTimersByTime(NETWORK_LATCH_MS);
      noteNetworkFailure();
      expect(isLostLatched()).toBe(false);
    });

    it("__resetConnectionHealth gives the strike back", () => {
      noteNetworkFailure();
      __resetConnectionHealth();
      vi.advanceTimersByTime(NETWORK_LATCH_MS);
      noteNetworkFailure();
      expect(isLostLatched()).toBe(false);
      noteNetworkFailure();
      expect(isLostLatched()).toBe(true);
    });
  });

  // NETWORK_LATCH_MS against the real poll: the herd read's deadline (lib/api.ts POLL_TIMEOUT_MS) and
  // the retry backoff after a read with no answer (hooks/use-polling.ts RETRY_MS, via intervalFor).
  // Each herd read fails `readMs` after it starts: POLL_TIMEOUT_MS for a tunnel that swallows the
  // request (a VPN up with the radio off), 0 for a read that fails at once (no route, a handover).
  describe("the latch window on the real poll schedule", () => {
    const idle: PollIntent = { bursting: false, following: true, changed: false };
    // The fastest cadence (a create or close catching up) and the slowest (nobody watching).
    const fast: PollIntent = { ...idle, topologyBursting: true };

    // Herd reads fail from `firstReadAt` on (ms after the anchor) until `liveAt`, if given. Returns the
    // ms after the anchor at which the outage latched, or null if it never did.
    function latchAt(
      readMs: number,
      intent: PollIntent,
      firstReadAt: number,
      liveAt = Number.POSITIVE_INFINITY,
    ): number | null {
      const start = Date.now();
      let readAt = firstReadAt;
      for (let failures = 1; readAt < CONNECTION_LOST_MS; failures++) {
        if (readAt >= liveAt) {
          vi.setSystemTime(start + readAt);
          markLive();
          return null;
        }
        vi.setSystemTime(start + readAt + readMs);
        noteNetworkFailure();
        if (isLostLatched()) return readAt + readMs;
        readAt += readMs + intervalFor(undefined, "p1", { ...intent, failures });
      }
      return null;
    }

    it("pins the poll the latch counts on: a 6 s deadline and a 0.5 s first retry", () => {
      expect(POLL_TIMEOUT_MS).toBe(6_000);
      expect(RETRY_MS).toBe(500);
      expect(intervalFor(undefined, "p1", { ...idle, failures: 1 })).toBe(RETRY_MS);
    });

    it("a read that fails at once and fails its retry 0.5 s later, then answers, latches nothing", () => {
      markWake();
      expect(latchAt(0, idle, 0, RETRY_MS + 1)).toBeNull();
      expect(isLostLatched()).toBe(false);
    });

    it("a dead tunnel after a wake latches on the retry, at its deadline, as the wake rule did", () => {
      markWake();
      // The first read ends inside the window (a strike), the retry's end is past it.
      expect(POLL_TIMEOUT_MS).toBeLessThan(NETWORK_LATCH_MS);
      expect(2 * POLL_TIMEOUT_MS + RETRY_MS).toBeGreaterThanOrEqual(NETWORK_LATCH_MS);
      expect(latchAt(POLL_TIMEOUT_MS, idle, 0)).toBe(2 * POLL_TIMEOUT_MS + RETRY_MS);
    });

    it("a read that fails at once after a wake latches on the first retry past the window, before the 15 s clock", () => {
      for (const intent of [fast, idle]) {
        __resetConnectionHealth();
        const at = latchAt(0, intent, 0);
        expect(at).not.toBeNull();
        expect(at!).toBeGreaterThanOrEqual(NETWORK_LATCH_MS);
        expect(at!).toBeLessThan(CONNECTION_LOST_MS);
      }
    });
  });
});
