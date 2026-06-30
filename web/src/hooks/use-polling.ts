import { useEffect, useRef } from "react";
import { useRevalidator } from "react-router";

import type { HomeData } from "@/lib/loaders";

// Adaptive polling, the React Router way: a timer that calls `revalidator.revalidate()`, which
// re-runs every active loader (snapshot + the open pane) — our equivalent of a refetch interval.
//  - fast (1.5s) while any agent is active OR a pane is open (you're watching it live), slow (4s)
//    when idle on the home screen with no active work;
//  - skipped while the tab is hidden (battery) or the device is offline (no point spinning the
//    radio on a dead connection), and kicked immediately on focus/online.
const HOT_MS = 1500;
const COLD_MS = 4000;

/**
 * Pure cadence resolver — exported so it can be unit-tested in isolation.
 *
 * Returns HOT_MS when:
 *   - Any agent anywhere in the herd is `working` or `blocked`, OR
 *   - A pane detail is open (paneId is set) and that pane exists in agents ∪ shellPanes.
 *     A shell you've drilled into is implicitly "live" regardless of its status.
 *
 * Returns COLD_MS otherwise (home screen, idle herd, no pane open).
 */
export function intervalFor(data: HomeData | undefined, paneId?: string | null): number {
  const anyActive = data?.agents.some((a) => a.status === "blocked" || a.status === "working");
  if (anyActive) return HOT_MS;

  if (paneId) {
    const allPanes = [...(data?.agents ?? []), ...(data?.shellPanes ?? [])];
    if (allPanes.some((p) => p.paneId === paneId)) return HOT_MS;
  }

  return COLD_MS;
}

export function usePolling(data: HomeData | undefined, paneId?: string | null): void {
  const revalidator = useRevalidator();
  // Hold the revalidator in a ref so the effect only re-subscribes when the cadence changes,
  // not on every revalidation (its identity flips each cycle).
  const ref = useRef(revalidator);
  ref.current = revalidator;

  const ms = intervalFor(data, paneId);

  useEffect(() => {
    const tick = () => {
      if (document.hidden) return;
      // navigator.onLine can be unreliable, but as a cheap guard to avoid spinning the radio
      // during a clear network drop it's worthwhile. The `online` listener below kicks an
      // immediate revalidate on reconnect, so we never miss a beat when coming back online.
      if (!navigator.onLine) return;
      if (ref.current.state === "idle") ref.current.revalidate();
    };
    const id = window.setInterval(tick, ms);
    const onWake = () => tick();
    const onVisible = () => {
      if (!document.hidden) tick();
    };
    window.addEventListener("focus", onWake);
    window.addEventListener("online", onWake);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("online", onWake);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ms]);
}
