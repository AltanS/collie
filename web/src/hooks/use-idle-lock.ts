import { useCallback, useEffect, useRef, useState } from "react";

// Stolen-/unattended-phone mitigation: after a stretch of no interaction we lock the app, which
// also pauses all polling until the user taps to resume. This mirrors the original bridge's
// 30-minute idle re-confirm.
const DEFAULT_IDLE_MS = 30 * 60 * 1000;

export function useIdleLock(idleMs = DEFAULT_IDLE_MS) {
  const [locked, setLocked] = useState(false);
  // Wall-clock timestamp of the last REAL interaction. The lock deadline is measured from here, so
  // a backgrounded tab (whose timers get throttled) still locks the instant it's foregrounded past
  // the deadline — visibility flips are deliberately NOT counted as activity.
  const lastActivity = useRef(Date.now());

  const unlock = useCallback(() => {
    lastActivity.current = Date.now();
    setLocked(false);
  }, []);

  useEffect(() => {
    if (locked) return; // no activity tracking while locked
    lastActivity.current = Date.now();

    let timer: ReturnType<typeof setTimeout> | undefined;

    // On fire, re-check against the timestamp: if fresh activity pushed the deadline out we just
    // re-arm for the remainder; otherwise we lock.
    const check = () => {
      if (Date.now() - lastActivity.current >= idleMs) setLocked(true);
      else arm();
    };
    // (Re)schedule a single timeout for exactly the time left until the deadline.
    function arm() {
      if (timer) clearTimeout(timer);
      const remaining = idleMs - (Date.now() - lastActivity.current);
      timer = setTimeout(check, Math.max(0, remaining));
    }

    // Only real input re-arms the deadline — NOT visibilitychange, which is why backgrounding and
    // foregrounding no longer resets the countdown.
    const onActivity = () => {
      lastActivity.current = Date.now();
      arm();
    };
    // Returning to the foreground: throttled background timers may not have fired, so check the
    // elapsed time right now and lock if we're already past the deadline.
    const onVisibility = () => {
      if (document.visibilityState === "visible") check();
    };

    arm();
    document.addEventListener("pointerdown", onActivity, { passive: true });
    document.addEventListener("keydown", onActivity, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("pointerdown", onActivity);
      document.removeEventListener("keydown", onActivity);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [locked, idleMs]);

  return { locked, unlock };
}
