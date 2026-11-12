import { useCallback, useLayoutEffect, useRef } from "react";

// THE SETTLE WINDOW, shared by every control a program or an agent draws and can redraw under the finger:
// an agent view's buttons (components/agent-view-screen.tsx, review 10 W3) and a trick's rows in a
// session's settings (components/trick-menu-group.tsx, the menu place). The rev a tap names is current,
// so the bridge would take it; only the phone knows that the control under the finger mounted, changed
// its words or moved a moment ago, so the person may have aimed at something else.

/** How long a control must stand still before a tap on it counts, in ms. */
export const SETTLE_MS = 500;

/**
 * Whether `layout` has stood still for `settleMs`: `layout` names everything that places or words a
 * control, and any change to it starts the window again. The answer is read at the tap, from the clock,
 * so no timer runs.
 */
export function useSettled(layout: string, settleMs: number = SETTLE_MS): () => boolean {
  const since = useRef<number | null>(null);
  useLayoutEffect(() => {
    since.current = Date.now();
  }, [layout]);
  return useCallback(() => since.current !== null && Date.now() - since.current >= settleMs, [settleMs]);
}
