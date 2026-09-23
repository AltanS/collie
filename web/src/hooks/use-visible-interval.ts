import { useEffect, useRef } from "react";

import { isLocked } from "@/lib/idle";

/**
 * How often an open Changes screen, and the dashboard's Changes tab, read again while the page is
 * visible (ADR 0065 rule 8, ADR 0066). The one number both screens beat to.
 */
export const CHANGES_POLL_MS = 5000;

/**
 * A beat that falls while the operator scrolls or touches the screen waits until this long after
 * the last such input, so an update never moves a list under a finger.
 */
export const ACTIVITY_IDLE_MS = 1000;

// The operator's hands, watched once for the whole page. Capture phase, because `scroll` does not
// bubble and every list here scrolls inside its own box; passive, so nothing here slows a scroll.
let lastActivity = Number.NEGATIVE_INFINITY;
let touching = false;
let watching = false;

function watchActivity(): void {
  if (watching) return;
  watching = true;
  const mark = () => {
    lastActivity = Date.now();
  };
  const opts = { capture: true, passive: true } as const;
  for (const type of ["scroll", "wheel", "touchmove"] as const) document.addEventListener(type, mark, opts);
  document.addEventListener(
    "touchstart",
    () => {
      touching = true;
      mark();
    },
    opts,
  );
  const lift = (e: TouchEvent) => {
    touching = e.touches.length > 0;
    mark();
  };
  document.addEventListener("touchend", lift, opts);
  document.addEventListener("touchcancel", lift, opts);
}

/** Milliseconds until the operator counts as idle again: 0 when idle now. A held finger never is. */
function busyFor(): number {
  if (touching) return ACTIVITY_IDLE_MS;
  return Math.max(0, lastActivity + ACTIVITY_IDLE_MS - Date.now());
}

/**
 * Call `onTick` every `intervalMs` while the page is visible, and once at once when it becomes
 * visible again. One loop for every screen that re-reads on a beat: the Changes screen
 * (routes/changes.tsx) and the dashboard's Changes tab (use-workspace-change-counts.ts). Hidden,
 * the timer is stopped outright, so a phone in a pocket wakes nothing; behind the idle lock a tick
 * is skipped, like the root poll (lib/idle.ts). The first call comes one interval after mount: the
 * screen reads on open by its own path.
 *
 * A beat that finds the operator scrolling or touching is held, not dropped: it fires once they have
 * been still for {@link ACTIVITY_IDLE_MS}, and the regular beat carries on from there.
 *
 * `onTick` is read through a ref, so a new callback every render never restarts the timer. Keeping
 * requests from overlapping is the caller's job, because only the caller knows what is in flight.
 */
export function useVisibleInterval(onTick: () => void, intervalMs: number, enabled = true): void {
  const tick = useRef(onTick);
  useEffect(() => {
    tick.current = onTick;
  });

  useEffect(() => {
    if (!enabled) return;
    watchActivity();
    let timer: ReturnType<typeof setInterval> | null = null;
    // A held beat, waiting for the operator's hands to be still.
    let held: ReturnType<typeof setTimeout> | null = null;
    // Visibility is asked again at every beat, not trusted from the last event: a beat that finds
    // the page hidden does nothing, even if no `visibilitychange` said so.
    const fire = () => {
      if (held !== null) return;
      if (document.visibilityState !== "visible" || isLocked()) return;
      const wait = busyFor();
      if (wait === 0) {
        tick.current();
        return;
      }
      held = setTimeout(() => {
        held = null;
        fire();
      }, wait);
    };
    const start = () => {
      if (timer === null) timer = setInterval(fire, intervalMs);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      if (held !== null) clearTimeout(held);
      timer = null;
      held = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        fire();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs, enabled]);
}
