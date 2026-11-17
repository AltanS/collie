import { useEffect, useState } from "react";

/**
 * How long a first frame waits for a read that is on its way before it draws what it has. Short enough
 * that nobody notices a wait, long enough for a bridge on the same tailnet to answer. One number for the
 * calm-load line (DESIGN.md §2, rule 3): a part must not enter the middle of a page after the first paint.
 */
export const CALM_HOLD_MS = 400;

/**
 * Whether a part is still held back: true while `holding` is true and the bound has not passed, counted
 * from the mount. The bound cannot be extended, so a read that never answers costs one hold, not a blank
 * page. Past it the caller draws as it did before the hold existed.
 */
export function useBoundedHold(holding: boolean, ms: number = CALM_HOLD_MS): boolean {
  const [spent, setSpent] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSpent(true), ms);
    return () => clearTimeout(timer);
  }, [ms]);
  return holding && !spent;
}
