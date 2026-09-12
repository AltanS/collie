import { useEffect, useState } from "react";

/**
 * A counter that runs on THE PHONE'S OWN CLOCK, never off a poll result (M20/08).
 *
 * This is the whole point. During `restarting` the bridge is down, every poll fails, and a number
 * derived from the last successful read would freeze at exactly the moment the operator most needs
 * proof that something is alive. A `setInterval` on the phone cannot be stopped by a dead server.
 *
 * Lifted out of `components/update-card.tsx` (M28/01) because the update screen needs the same
 * clock: the sheet counts the device's own download and the lead's elapsed time while the bridge it
 * is reading about is deliberately away.
 */
export function useTick(active: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [active, everyMs]);
  return now;
}
