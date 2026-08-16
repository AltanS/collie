import { useEffect, useState } from "react";
import { useNavigation, useRevalidator } from "react-router";

// A normal poll or route change settles in well under 300ms, so this default threshold never trips
// on healthy traffic — it deliberately preserves the "no flicker on every tick" property. It only
// fires when a load genuinely hangs (a black-holed fetch on a sleeping/wandering phone).
const DEFAULT_THRESHOLD_MS = 2_500;

/**
 * True once a load has been in flight — a background revalidation (`useRevalidator`) OR a route
 * navigation (`useNavigation`, e.g. tapping a pane row waits on its loader) — continuously for
 * `thresholdMs`. Resets to false the moment BOTH go idle.
 *
 * Covering navigation as well as revalidation is what makes a black-holed pane-open tap give
 * feedback: the tap is a router navigation that waits on `paneLoader`, so without this the app looks
 * completely dead until the loader's own timeout fires. It drives only the header's generic loading
 * animation, never a freshness or connection diagnosis.
 */
export function useLoadingStalled(thresholdMs = DEFAULT_THRESHOLD_MS): boolean {
  const revalidator = useRevalidator();
  const navigation = useNavigation();
  // One combined "something is loading" boolean drives a single timer. Keyed on this boolean, the
  // effect re-runs only on a true↔false edge: it starts the timer when a load begins and clears it
  // (resetting to false) the instant everything goes idle — so a burst of fast polls never trips it.
  const loading = revalidator.state === "loading" || navigation.state !== "idle";
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    if (!loading) {
      setStalled(false);
      return;
    }
    const id = window.setTimeout(() => setStalled(true), thresholdMs);
    return () => clearTimeout(id);
  }, [loading, thresholdMs]);

  return stalled;
}
