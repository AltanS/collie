import { useEffect, useRef, useState } from "react";

// How long the app must stay continuously not-live before we escalate from the quiet header pill
// ("reconnecting…") to a prominent prompt. Long enough that a normal poll blip, a pane-open hiccup,
// or a brief tunnel drop never trips it — only a genuinely sustained outage does.
export const CONNECTION_LOST_MS = 15_000;

/**
 * True once `connecting` (isConnecting — offline / snapshot error / Herdr down / stalled) has stayed
 * true continuously for CONNECTION_LOST_MS. Resets to false the instant `connecting` goes false, so a
 * recovered snapshot dismisses the prompt immediately.
 *
 * Mirrors useLoadingStalled's shape, but measures WALL-CLOCK elapsed (the SUPERSEDE_MS approach):
 * `since` stamps when the outage began, and `lost` is derived from real time elapsed, not a timer's
 * countdown — a phone that sleeps mid-outage and wakes still-disconnected escalates on the true
 * elapsed time rather than accumulated awake-time. A timer (and focus/online wakeups) only force the
 * re-render at which that derivation is recomputed.
 */
export function useConnectionLost(connecting: boolean, thresholdMs = CONNECTION_LOST_MS): boolean {
  const since = useRef<number | null>(null);
  // A bare re-render nudge: the derived `lost` below is the source of truth; this just makes React
  // re-evaluate it at the threshold moment (and on wake) even when no poll happens to re-render us.
  const [, tick] = useState(0);

  if (connecting) {
    if (since.current === null) since.current = Date.now();
  } else {
    since.current = null;
  }

  useEffect(() => {
    if (!connecting) return;
    const recheck = () => tick((n) => n + 1);
    const elapsed = since.current === null ? 0 : Date.now() - since.current;
    const id = window.setTimeout(recheck, Math.max(0, thresholdMs - elapsed));
    // Timers freeze while the phone sleeps, so re-measure real elapsed time on wake.
    window.addEventListener("focus", recheck);
    window.addEventListener("online", recheck);
    return () => {
      clearTimeout(id);
      window.removeEventListener("focus", recheck);
      window.removeEventListener("online", recheck);
    };
  }, [connecting, thresholdMs]);

  return connecting && since.current !== null && Date.now() - since.current >= thresholdMs;
}
