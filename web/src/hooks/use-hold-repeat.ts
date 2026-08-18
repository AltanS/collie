import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, SyntheticEvent } from "react";

import { buzz } from "@/lib/haptics";

// Hold-to-repeat for the nav tray's arrow keys. Driving a long TUI menu from a phone meant tapping ↓
// fifteen times; holding it should just repeat, the way a physical keyboard does.
//
// The sending model is a ONE-IN-FLIGHT PUMP, not a fixed-cadence emitter, and that is a correctness
// requirement rather than latency hygiene: Herdr's RPC is one-shot (a fresh connection per call, the
// server closes after one reply), so ordering across two concurrent `send_keys` calls is NOT
// guaranteed — only ordering WITHIN one array is. So we never allow two calls in flight; repeats
// accumulate locally and flush as one batched array whenever the previous call resolves. A laggy
// tailnet therefore produces BIGGER batches, not more calls, which is exactly what the array-taking
// API is for.
//
// Deliberately NOT in lib/key-queue.ts (pure composition — no I/O, no time, no React) and not in the
// Composer (whose pressKeys stays a dumb transport). Pointer state, timers and the pump live here.

/** Hold must exceed this before repeat engages — below it, the press is an ordinary tap and the
 *  button's own onClick handles it exactly as before (so single-tap behaviour is untouched). */
const HOLD_DELAY_MS = 350;

/** Cadence of the local accumulator once engaged. Network pacing is handled by the pump, not this. */
const REPEAT_MS = 90;

/** Ceiling on one flushed array — a slow round-trip shouldn't let a hold build an enormous batch. */
const MAX_BATCH = 25;

/** Dead-man ceiling on a single hold. If a pointerup is ever lost, this stops the repeat anyway:
 *  the failure mode being guarded is a phone holding ↓ forever inside a real terminal. */
const MAX_HOLD_MS = 4_000;

export interface HoldRepeatBinding {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
  onContextMenu: (e: SyntheticEvent) => void;
  onClick: (e: SyntheticEvent) => void;
}

export interface HoldRepeat {
  /** Spread onto a repeatable button. `key` is the wire key it repeats (e.g. "Down"). `onTap` is the
   *  button's ordinary single-press handler — invoked on click ONLY when no hold engaged. */
  bind: (key: string, onTap: () => void) => HoldRepeatBinding;
  /** The key currently being held (repeat engaged), or null. */
  holding: string | null;
  /** How many repeats have been emitted for the current hold — drives the "×12" readout. */
  count: number;
}

/**
 * @param onFlush Sends `count` copies of `key` as ONE call; resolves when the bridge has answered.
 *                Falsy resolution stops the hold (a refused key shouldn't keep hammering).
 * @param enabled False disables repeat entirely — pass `!composing`, because a hold must never stage
 *                fifteen identical chips into a queue whose whole value is reviewability.
 */
export function useHoldRepeat(
  onFlush: (key: string, count: number) => Promise<boolean>,
  enabled: boolean,
): HoldRepeat {
  const [holding, setHolding] = useState<string | null>(null);
  const [count, setCount] = useState(0);

  // All mutable pump state in refs — it must not re-render on every tick.
  const engageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);
  const deadman = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heldKey = useRef<string | null>(null);
  const pending = useRef(0);
  const inFlight = useRef(false);
  /** Set once a hold engages, so the synthesized click that follows the release is swallowed
   *  (otherwise the tap path would send one extra key on top of everything the pump sent). */
  const engaged = useRef(false);
  const alive = useRef(true);
  // onFlush is re-created each render by the caller; read it through a ref so the pump closure never
  // goes stale without making every callback below depend on it.
  const flushRef = useRef(onFlush);
  flushRef.current = onFlush;

  const stopTimers = useCallback(() => {
    if (engageTimer.current) clearTimeout(engageTimer.current);
    if (ticker.current) clearInterval(ticker.current);
    if (deadman.current) clearTimeout(deadman.current);
    engageTimer.current = null;
    ticker.current = null;
    deadman.current = null;
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stopTimers();
      heldKey.current = null;
      pending.current = 0;
    };
  }, [stopTimers]);

  // Drain the accumulator, one call at a time. Re-entrant by design: each completion pumps again, so
  // a hold self-clocks to whatever the network is actually doing.
  const pump = useCallback(() => {
    if (inFlight.current || pending.current === 0) return;
    const key = heldKey.current;
    if (key === null) return;
    const n = Math.min(pending.current, MAX_BATCH);
    pending.current -= n;
    inFlight.current = true;
    void (async () => {
      try {
        const ok = await flushRef.current(key, n);
        if (!ok) {
          // A refused key means the pane isn't taking input — stop rather than hammer it.
          pending.current = 0;
          heldKey.current = null;
          stopTimers();
          if (alive.current) setHolding(null);
        }
      } finally {
        inFlight.current = false;
        if (alive.current) pump();
      }
    })();
  }, [stopTimers]);

  // End the hold: stop accumulating, flush whatever is left, drop the visual state. `heldKey` stays
  // set until the pump drains so the trailing flush still knows which key it is sending.
  const release = useCallback(() => {
    stopTimers();
    if (heldKey.current !== null) pump();
    if (pending.current === 0) heldKey.current = null;
    setHolding(null);
    setCount(0);
  }, [pump, stopTimers]);

  const bind = useCallback(
    (key: string, onTap: () => void): HoldRepeatBinding => ({
      onPointerDown: (e) => {
        if (!enabled) return;
        engaged.current = false;
        // Capture so a thumb sliding off the button still delivers pointerup here — an uncaptured
        // pointer that leaves the element strands the timers, which is the runaway-repeat scenario.
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // Capture is best-effort; the dead-man timer is the real backstop.
        }
        engageTimer.current = setTimeout(() => {
          engaged.current = true;
          heldKey.current = key;
          pending.current = 1;
          setHolding(key);
          setCount(1);
          buzz(); // engage only — a buzz per repeat tick would turn the phone into a massager
          pump();
          ticker.current = setInterval(() => {
            pending.current += 1;
            setCount((c) => c + 1);
            pump();
          }, REPEAT_MS);
          deadman.current = setTimeout(release, MAX_HOLD_MS);
        }, HOLD_DELAY_MS);
      },
      onPointerUp: () => {
        if (engageTimer.current) {
          clearTimeout(engageTimer.current);
          engageTimer.current = null;
        }
        if (engaged.current) release();
      },
      onPointerCancel: () => {
        if (engageTimer.current) {
          clearTimeout(engageTimer.current);
          engageTimer.current = null;
        }
        if (engaged.current) release();
      },
      // iOS fires a long-press selection callout over a held button without this.
      onContextMenu: (e) => e.preventDefault(),
      onClick: (e) => {
        // A hold already sent everything through the pump; the release's synthesized click must not
        // add one more. A plain tap never engaged, so it falls through to the normal handler.
        if (engaged.current) {
          e.preventDefault();
          engaged.current = false;
          return;
        }
        onTap();
      },
    }),
    [enabled, pump, release],
  );

  return { bind, holding, count };
}
