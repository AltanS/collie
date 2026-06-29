import { useEffect, useRef } from "react";
import { useRevalidator } from "react-router-dom";

import type { HomeData } from "@/lib/loaders";

// Adaptive polling, the React Router way: a timer that calls `revalidator.revalidate()`, which
// re-runs every active loader (snapshot + the open pane). Replaces TanStack's refetchInterval.
//  - fast (1.5s) while any agent is active, slow (4s) when idle — the bridge itself only refreshes
//    its Herdr view ~every 1.5s, so polling faster buys nothing;
//  - skipped while the tab is hidden (battery), and kicked immediately on focus/online.
const HOT_MS = 1500;
const COLD_MS = 4000;

function intervalFor(data: HomeData | undefined): number {
  const hot = data?.agents.some((a) => a.status === "blocked" || a.status === "working");
  return hot ? HOT_MS : COLD_MS;
}

export function usePolling(data: HomeData | undefined): void {
  const revalidator = useRevalidator();
  // Hold the revalidator in a ref so the effect only re-subscribes when the cadence changes,
  // not on every revalidation (its identity flips each cycle).
  const ref = useRef(revalidator);
  ref.current = revalidator;

  const ms = intervalFor(data);

  useEffect(() => {
    const tick = () => {
      if (document.hidden) return;
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
