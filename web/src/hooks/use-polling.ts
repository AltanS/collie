import { useEffect, useRef } from "react";
import { useRevalidator } from "react-router";

import type { HomeData } from "@/lib/loaders";

// Adaptive polling, the React Router way: a timer that calls `revalidator.revalidate()`, which
// re-runs every active loader (snapshot + the open pane) — our equivalent of a refetch interval.
//  - fast (1.5s) while any agent is active OR a pane is open (you're watching it live), slow (4s)
//    when idle on the home screen with no active work;
//  - skipped only while the tab is hidden (battery); it deliberately does NOT gate on
//    navigator.onLine (that flag lies on some phones and would wedge polling forever — see the tick),
//    and it's kicked immediately on focus/online/visibility as an accelerator.
const HOT_MS = 1500;
const COLD_MS = 4000;

// Self-heal a wedged revalidation. Normally a tick no-ops while one is already in flight (see the
// idle fast-path below), but a black-holed fetch can stay `loading` forever (its timeout aside — the
// timer itself can freeze while the phone sleeps). Once a revalidation has been loading for longer
// than this — just past GET_TIMEOUT_MS (10s) as a belt-and-braces margin — a tick kicks a fresh
// revalidate() anyway: React Router aborts/supersedes the hung one (loaders treat that AbortError as
// "superseded"). We compare against wall-clock (Date.now), not a timer, precisely because timers can
// stop advancing during sleep — the age we care about is real elapsed time since the load began.
export const SUPERSEDE_MS = 12_000;

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

  // Wall-clock timestamp of when the current revalidation began, or null when idle. Stamped on the
  // idle→loading edge and cleared on →idle, so a tick can tell how long a load has been in flight
  // (used to detect and supersede a wedged one). A ref, not state — it must not trigger re-renders.
  const loadingSince = useRef<number | null>(null);
  if (revalidator.state === "loading") {
    if (loadingSince.current === null) loadingSince.current = Date.now();
  } else {
    loadingSince.current = null;
  }

  const ms = intervalFor(data, paneId);

  useEffect(() => {
    const tick = () => {
      if (document.hidden) return;
      // Deliberately NO navigator.onLine gate here. On some phones the flag lies — it stuck FALSE
      // after an airplane-mode toggle even though the network was back — and gating the tick on it
      // wedged polling permanently: the app froze on "not connected" with a resting/bad-state dog and
      // a stale mirror forever, because it never fetched again to discover the network had returned. A
      // failed fetch on a genuinely dead connection is cheap and self-heals the instant it's back; the
      // focus/online/visibility listeners below only accelerate that first beat. Never STOP fetching
      // because a possibly-lying flag says offline.
      const r = ref.current;
      if (r.state === "idle") {
        r.revalidate();
        return;
      }
      // Already loading: normally we leave it be, but a revalidation stuck past SUPERSEDE_MS is
      // almost certainly a black-holed fetch — kick a fresh one to supersede it and self-heal.
      const since = loadingSince.current;
      if (since !== null && Date.now() - since >= SUPERSEDE_MS) r.revalidate();
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
