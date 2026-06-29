import { useCallback, useEffect, useRef, useState } from "react";

// Stolen-/unattended-phone mitigation: after a stretch of no interaction we lock the app, which
// also pauses all polling until the user taps to resume. This mirrors the original bridge's
// 30-minute idle re-confirm.
const DEFAULT_IDLE_MS = 30 * 60 * 1000;

export function useIdleLock(idleMs = DEFAULT_IDLE_MS) {
  const [locked, setLocked] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const arm = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setLocked(true), idleMs);
  }, [idleMs]);

  const unlock = useCallback(() => {
    setLocked(false);
    arm();
  }, [arm]);

  useEffect(() => {
    if (locked) return; // no activity tracking while locked
    arm();
    const reset = () => arm();
    const events: (keyof DocumentEventMap)[] = ["pointerdown", "keydown", "visibilitychange"];
    for (const e of events) document.addEventListener(e, reset, { passive: true });
    return () => {
      for (const e of events) document.removeEventListener(e, reset);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [locked, arm]);

  return { locked, unlock };
}
