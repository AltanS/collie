import { useCallback, useEffect } from "react";

import { setLocked, useLocked } from "@/lib/idle";

// Pause an UNATTENDED, VISIBLY-OPEN Collie: after a stretch with no interaction we cover the app and
// stop polling until it's resumed. Two rules define the feature, and both are load-bearing:
//
//   • We never lock a HIDDEN page. A backgrounded tab already polls nothing (use-polling skips every
//     tick while `document.hidden`), so locking it buys exactly zero — the lock would only ever be
//     discovered later, as friction, by someone returning to their own app.
//   • Returning to the foreground AUTO-RESUMES. A lock you meet on the way back is pure ceremony: it
//     guards nothing a page reload didn't already bypass, and it costs a tap every single time.
//
// Together those mean the lock can only appear one way — you left Collie open, visible and untouched
// past the deadline (a desk, a tablet; almost never a phone, whose screen sleeps long first). That is
// the case where covering the screen and dropping the poll actually earns its keep.
//
// This deliberately does NOT gate access: see .adr/0007. The lock is a battery/attention pause, not
// auth — Tailscale proves the device and there is no session to re-confirm.
const DEFAULT_IDLE_MS = 30 * 60 * 1000;

export function useIdleLock(idleMs = DEFAULT_IDLE_MS): { locked: boolean; unlock: () => void } {
  // Lives in a module store, not local state: use-polling's tick has to read it too (see lib/idle).
  const locked = useLocked();
  const unlock = useCallback(() => setLocked(false), []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Wall-clock stamp of the last real interaction. The deadline is measured from here rather than
    // counted down by the timer, so a throttled background tab can't drift the arithmetic.
    let lastActivity = Date.now();

    // (Re)schedule one timeout for exactly the time left until the deadline.
    const arm = () => {
      if (timer) clearTimeout(timer);
      const remaining = idleMs - (Date.now() - lastActivity);
      timer = setTimeout(check, Math.max(0, remaining));
    };

    function check() {
      // Hidden: let the timer die rather than re-arm. Nothing needs pausing behind a hidden tab, and
      // re-arming on a already-elapsed deadline would spin a 0ms timeout. onVisibility restarts it.
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastActivity >= idleMs) setLocked(true);
      else arm();
    }

    const onActivity = () => {
      lastActivity = Date.now();
      arm();
    };

    // A return trip is a fresh start, never a verdict: stamp activity, auto-resume if we locked while
    // visible earlier, and re-arm the countdown from now.
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      lastActivity = Date.now();
      if (locked) {
        setLocked(false);
        return; // the effect re-runs on the state change and arms fresh
      }
      arm();
    };

    // Always listen for the return trip — including while locked, which is what makes auto-resume
    // work. Activity tracking and the countdown only matter while we're unlocked.
    document.addEventListener("visibilitychange", onVisibility);
    if (!locked) {
      arm();
      document.addEventListener("pointerdown", onActivity, { passive: true });
      document.addEventListener("keydown", onActivity, { passive: true });
    }

    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("pointerdown", onActivity);
      document.removeEventListener("keydown", onActivity);
    };
  }, [locked, idleMs]);

  return { locked, unlock };
}
