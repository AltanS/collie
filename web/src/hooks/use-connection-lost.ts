import { useEffect, useState } from "react";

import { CONNECTION_LOST_MS, useConnectionHealth } from "@/lib/connection-health";

// Re-exported so the many call sites and tests that import the threshold from here keep working; the
// constant itself now lives with the shared store in lib/connection-health.
export { CONNECTION_LOST_MS };

/**
 * True once `connecting` (isConnecting — offline / snapshot error / Herdr down / stalled) has stayed
 * true continuously for `thresholdMs`, measured from the last PROVABLY LIVE moment. Resets to false
 * the instant `connecting` goes false, so a recovered snapshot dismisses the prompt immediately.
 *
 * Derives entirely from the module-scoped lib/connection-health store — NOT a per-instance timer.
 * `lost` is a pure function of `connecting` and the shared `lastHealthyAt()` anchor, so every consumer
 * (header pill, outage banner, in-pane header, boot splash) computes the SAME answer and they cannot
 * disagree across remounts, route changes, or timer drift. The store subscription re-renders us when
 * the anchor moves (a successful poll or a wake); the timeout below forces the re-evaluation at the
 * exact threshold moment, and focus/online are cheap re-check nudges after the phone wakes (when
 * timers were frozen). Wall-clock throughout: a phone that sleeps mid-outage escalates on true elapsed
 * time, not accumulated awake-time.
 */
export function useConnectionLost(connecting: boolean, thresholdMs = CONNECTION_LOST_MS): boolean {
  // The shared anchor. Subscribing re-renders us whenever markLive/markWake advances it, and feeding
  // it into the effect deps below reschedules the threshold timer against the new anchor (e.g. a wake
  // grace pushes escalation back a fresh window).
  const anchor = useConnectionHealth();
  // A bare re-render nudge: `lost` below is the source of truth; this just makes React re-evaluate it
  // at the threshold moment (and on focus/online) even when no poll or store change re-renders us.
  const [, tick] = useState(0);

  useEffect(() => {
    if (!connecting) return;
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
  }, [connecting, thresholdMs, anchor]);

  return connecting && Date.now() - anchor >= thresholdMs;
}
