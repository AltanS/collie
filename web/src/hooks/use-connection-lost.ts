import { useEffect, useState } from "react";

import {
  CONNECTION_LOST_MS,
  TROUBLE_MS,
  latchLost,
  useConnectionHealth,
  useLongUpload,
} from "@/lib/connection-health";

// Re-exported so the many call sites and tests that import the thresholds from here keep working; the
// constants themselves live with the shared store in lib/connection-health.
export { CONNECTION_LOST_MS, TROUBLE_MS };

/**
 * Shared implementation for both connection thresholds: true once `connecting` (isConnecting —
 * offline / snapshot error / Herdr down / stalled) has stayed true continuously for `thresholdMs`,
 * measured from the last PROVABLY LIVE moment. Resets to false the instant `connecting` goes false.
 *
 * Derives entirely from the module-scoped lib/connection-health store — NOT a per-instance timer. The
 * result is a pure function of `connecting` and the shared escalation anchor (`useConnectionHealth`,
 * i.e. `effectiveAnchor()`), so every consumer at a given threshold computes the SAME answer and they
 * cannot disagree across remounts, route changes, or timer drift. The store subscription re-renders us
 * when the anchor moves (a successful poll or a wake); the timeout below forces the re-evaluation at
 * the exact threshold moment, and focus/online are cheap re-check nudges after the phone wakes (when
 * timers were frozen). Wall-clock throughout: a phone that sleeps mid-outage escalates on true elapsed
 * time, not accumulated awake-time.
 *
 * SUSPENDED WHILE THE OPERATOR IS UPLOADING. A voice clip is megabytes going up a phone's narrow
 * uplink; the snapshot poll queues behind it, looks stalled, and used to fade in the amber
 * "Reconnecting…" bar over a link that was working and was busy carrying the recording. So while
 * `useLongUpload()` is true neither threshold is reached and neither latches — the connection has not
 * proven itself dead, it has not been ASKED. Releasing the upload stamps a wake (see
 * lib/connection-health), so the window that follows is a fresh one rather than the stale anchor.
 *
 * `latch` is what separates the two thresholds. Only the 15s LOST escalation latches: the moment we
 * observe it we call latchLost(), and while latched the store drops the wake grace from the anchor, so
 * switching apps and returning MID-OUTAGE can't downgrade a red "not connected" to amber for another
 * window — red stays red until a live poll clears the latch (markLive). The 4s TROUBLE threshold NEVER
 * latches: it's the ambient amber, and latching it would freeze the sticky state at 4s and break the
 * red/green semantics. Both read the SAME latched-or-not anchor, so once latched (red) trouble is
 * trivially true too — bar and dog agree by construction.
 */
function useNotLiveFor(connecting: boolean, thresholdMs: number, latch: boolean): boolean {
  // The shared escalation anchor. Subscribing re-renders us whenever markLive/markWake/latchLost moves
  // it, and feeding it into the effect deps below reschedules the threshold timer against the new
  // anchor (e.g. a pre-latch wake pushes escalation back a fresh window; latching drops the wake grace).
  const anchor = useConnectionHealth();
  // The operator's own upload owns the uplink right now — see the header. Same store, same
  // subscription, so this and the anchor can never be read one render apart.
  const uploading = useLongUpload();
  // A bare re-render nudge: `reached` below is the source of truth; this just makes React re-evaluate
  // it at the threshold moment (and on focus/online) even when no poll or store change re-renders us.
  const [, tick] = useState(0);

  const reached = connecting && !uploading && Date.now() - anchor >= thresholdMs;

  // Latch the escalation the first time we observe it — but ONLY for the latching (15s lost) threshold.
  // Store-owned + idempotent, so all consumers agree and re-running is a no-op; it survives this
  // component's remounts because the flag lives in the module store, not here. Cleared only by markLive.
  useEffect(() => {
    if (latch && reached) latchLost();
  }, [latch, reached]);

  useEffect(() => {
    if (!connecting || uploading) return;
    const recheck = () => tick((n) => n + 1);
    const elapsed = Date.now() - anchor;
    const id = window.setTimeout(recheck, Math.max(0, thresholdMs - elapsed));
    // Timers freeze while the phone sleeps; focus/online re-measure real elapsed time on wake.
    window.addEventListener("focus", recheck);
    window.addEventListener("online", recheck);
    return () => {
      clearTimeout(id);
      window.removeEventListener("focus", recheck);
      window.removeEventListener("online", recheck);
    };
  }, [connecting, uploading, thresholdMs, anchor]);

  return reached;
}

/**
 * The STICKY 15s escalation — true once `connecting` has held continuously for `thresholdMs` (default
 * CONNECTION_LOST_MS), and it LATCHES: a mid-outage app switch (wake) can't downgrade it back to amber
 * for another window; the latch clears only when a live poll proves recovery. Drives the red
 * connection bar and the muted "not connected" dog. Also the BootSplash's stuck-cold-start escalation.
 */
export function useConnectionLost(connecting: boolean, thresholdMs = CONNECTION_LOST_MS): boolean {
  return useNotLiveFor(connecting, thresholdMs, true);
}

/**
 * The ambient 4s trouble threshold — true once `connecting` has held continuously for `thresholdMs`
 * (default TROUBLE_MS). Shares the SAME anchor as useConnectionLost but NEVER latches, so it's a pure
 * "have we been not-live for a sustained beat" signal: below it a single slow poll or one failed fetch
 * shows nothing (the flicker fix). Drives the amber "reconnecting…" bar and the galloping dog.
 */
export function useConnectionTrouble(connecting: boolean, thresholdMs = TROUBLE_MS): boolean {
  return useNotLiveFor(connecting, thresholdMs, false);
}
