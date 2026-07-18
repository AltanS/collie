import { useEffect } from "react";
import { useNavigation, useRevalidator } from "react-router";

import { setPollBusy } from "@/lib/busy";

// A healthy poll or route change settles well under this, so the busy bar stays invisible on routine
// traffic — that anti-flicker property is deliberate (see connection-bar's resolve() note). Only a
// revalidation/navigation still in flight past here (a laggy link or bridge) surfaces the strip.
export const POLL_BUSY_THRESHOLD_MS = 500;

/**
 * Feed the app-wide busy bar from a SLOW background load — a revalidation (`useRevalidator`, the
 * poll) or a route navigation (`useNavigation`, e.g. opening a pane) that stays in flight past
 * `thresholdMs`. Mount ONCE inside the router (RootLayout). A fast poll never shows the bar (the
 * timer is cleared before it fires); the signal resets the instant loading stops and on unmount, so
 * the bar can never get stuck on. Complements the mutation counter in lib/busy.
 */
export function usePollBusy(thresholdMs = POLL_BUSY_THRESHOLD_MS): void {
  const revalidator = useRevalidator();
  const navigation = useNavigation();
  // One combined "a load is in flight" boolean drives a single timer, keyed on the boolean so the
  // effect re-runs only on a true↔false edge — a burst of fast polls never trips it.
  const loading = revalidator.state === "loading" || navigation.state !== "idle";

  useEffect(() => {
    if (!loading) {
      setPollBusy(false);
      return;
    }
    const id = window.setTimeout(() => setPollBusy(true), thresholdMs);
    return () => clearTimeout(id);
  }, [loading, thresholdMs]);

  // Clear the signal if this unmounts mid-poll (the idle-lock swaps the whole router out).
  useEffect(() => () => setPollBusy(false), []);
}
