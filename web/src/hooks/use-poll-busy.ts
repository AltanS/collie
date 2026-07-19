import { useEffect, useState } from "react";
import { useNavigation, useRevalidator } from "react-router";

import { setPollBusy } from "@/lib/busy";

// A route navigation is USER-BLOCKING — the user just tapped something (e.g. opening a pane) and is
// staring at the screen waiting on it. A healthy navigation settles well under this, so the busy bar
// stays invisible on routine taps; only a navigation still in flight past here (a laggy link) surfaces
// the strip. Kept short/snappy because the user is actively watching for feedback.
export const NAV_BUSY_THRESHOLD_MS = 500;

// A background revalidation (the poll) is AMBIENT — nobody is staring at it, so the strip should
// only fire when a poll has HUNG, not merely when the link is slow. On-device, over the user's
// HTTPS reverse proxy with large streaming-pane payloads on a 1.5s hot-poll cadence, single
// revalidations routinely sit in flight for 0.5–3s as chronic-but-normal behavior for that link —
// "stops briefly, then continues" is not a problem and must never surface the strip. This threshold
// is well past any plausible normal round-trip on that link (roughly halfway to the 12s supersede
// kick in use-polling.ts's SUPERSEDE_MS, which force-restarts a poll stuck that long), so crossing
// it is rare and means the poll is actually stuck — a signal worth surfacing as reassurance the app
// isn't dead, not ambient noise on every slow tick.
export const POLL_BUSY_THRESHOLD_MS = 6_000;

/**
 * Feed the app-wide busy bar from two independent slow-load signals, each against its own
 * threshold: a route navigation (`useNavigation`, e.g. opening a pane — user-blocking,
 * `navThresholdMs`) and a background revalidation (`useRevalidator`, the poll — ambient,
 * `pollThresholdMs`). Mount ONCE inside the router (RootLayout).
 *
 * The two signals OR together into the shared `setPollBusy`: they can overlap (a poll already
 * stalled when you open a pane), and the bar shows the instant EITHER is past its own threshold,
 * clearing only once BOTH have settled. A fast load on either axis never shows the bar (its timer is
 * cleared before it fires); each signal resets to false the instant its own loading stops, and
 * unmount clears both. Complements the mutation counter in lib/busy.
 */
export function usePollBusy(
  navThresholdMs = NAV_BUSY_THRESHOLD_MS,
  pollThresholdMs = POLL_BUSY_THRESHOLD_MS,
): void {
  const revalidator = useRevalidator();
  const navigation = useNavigation();
  // Two independent booleans, each driving its own timer — keyed on the boolean (not the raw state
  // string/object), so each effect re-runs only on its own true↔false edge. A burst of fast polls
  // never trips the poll timer, and it can't be reset early by an unrelated navigation edge (or
  // vice versa) since the two timers are fully decoupled.
  const navLoading = navigation.state !== "idle";
  const pollLoading = revalidator.state === "loading";

  const [navPast, setNavPast] = useState(false);
  const [pollPast, setPollPast] = useState(false);

  useEffect(() => {
    if (!navLoading) {
      setNavPast(false);
      return;
    }
    const id = window.setTimeout(() => setNavPast(true), navThresholdMs);
    return () => clearTimeout(id);
  }, [navLoading, navThresholdMs]);

  useEffect(() => {
    if (!pollLoading) {
      setPollPast(false);
      return;
    }
    const id = window.setTimeout(() => setPollPast(true), pollThresholdMs);
    return () => clearTimeout(id);
  }, [pollLoading, pollThresholdMs]);

  // Publish the OR of the two onto the shared store whenever either edge flips. setPollBusy is
  // idempotent, so re-publishing an unchanged value (e.g. both effects settling on the same tick)
  // is a no-op.
  useEffect(() => {
    setPollBusy(navPast || pollPast);
  }, [navPast, pollPast]);

  // Clear the signal if this unmounts mid-load (the idle-lock swaps the whole router out).
  useEffect(() => () => setPollBusy(false), []);
}
