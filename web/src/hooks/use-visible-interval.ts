import { useEffect, useRef } from "react";

import { isLocked } from "@/lib/idle";

/**
 * Call `onTick` every `intervalMs` while the page is visible, and once at once when it becomes
 * visible again. One loop for every screen that re-reads on a beat: the Changes screen
 * (routes/changes.tsx) and the dashboard's Changes tab (use-workspace-change-counts.ts). Hidden, the timer is stopped outright, so a phone in a pocket wakes nothing; behind
 * the idle lock a tick is skipped, like the root poll (lib/idle.ts). The first call comes one
 * interval after mount: the screen reads on open by its own path.
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
    let timer: ReturnType<typeof setInterval> | null = null;
    // Visibility is asked again at every beat, not trusted from the last event: a beat that finds
    // the page hidden does nothing, even if no `visibilitychange` said so.
    const fire = () => {
      if (document.visibilityState === "visible" && !isLocked()) tick.current();
    };
    const start = () => {
      if (timer === null) timer = setInterval(fire, intervalMs);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
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
