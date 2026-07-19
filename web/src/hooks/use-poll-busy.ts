import { useEffect, useState } from "react";
import { useNavigation, useRevalidator } from "react-router";

import { setPollBusy } from "@/lib/busy";

// A route navigation is USER-BLOCKING — the user just tapped something (e.g. opening a pane) and is
// staring at the screen waiting on it. A healthy navigation settles well under this, so the busy bar
// stays invisible on routine taps; only a navigation still in flight past here (a laggy link) surfaces
// the strip. Kept short/snappy because the user is actively watching for feedback.
export const NAV_BUSY_THRESHOLD_MS = 500;

// A background revalidation (the poll) is AMBIENT — nobody is staring at it, so only SUSTAINED lag
// should surface the strip. On-device, over the user's HTTPS reverse proxy, a single poll routinely
// takes >500ms while the hot poll interval itself is only 1.5s — at the nav threshold the bar would
// re-trigger on nearly every tick and read as permanently stuck on. This threshold sits comfortably
// above a whole hot-poll interval, so a merely-slow-on-mobile poll (0.5–1.5s round trip) never trips
// it — only a genuinely degraded/laggy poll does.
export const POLL_BUSY_THRESHOLD_MS = 2_000;

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
