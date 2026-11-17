import { useEffect, useRef, useState } from "react";

import { CALM_HOLD_MS } from "@/hooks/use-bounded-hold";
import { fetchTelemetry } from "@/lib/api";
import { shouldShowTelemetryNotice, useTelemetryNoticeKind, type TelemetryNoticeKind } from "@/lib/telemetry-notice";
import type { TelemetryView } from "@/lib/types";

// THE TELEMETRY NOTICE'S ONE READ, AND ITS BOUND (calm load, row 16). The notice stands at the top of the
// Dashboard's scroller, and a notice that opens there after the list has painted pushes the whole list
// down. The device already knows whether it spent the notice, so only a device that did NOT asks the
// machine, with one best-effort GET, and on the first look of this page session that device waits for the
// answer for at most `CALM_HOLD_MS` before the list is drawn: `held` is true until the read answers, fails
// or the bound passes, and the route keeps the scroller's content unseen meanwhile (`invisible`, so it is
// laid out and nothing in it moves when it is shown). An answer inside the bound hands the notice over
// already open, in the frame the list appears. An answer past the bound is dropped for this load, so the
// notice never opens above a list the person is already reading; the next load finds it known.
//
// The answer is kept in memory for the page session (never in storage), so the Dashboard, which remounts
// on every move to a pane and back, draws the notice, or nothing, in its first frame and waits for nothing.
// It still asks again each time, and the new answer is taken when it only closes the notice or arrives
// inside the hold: a notice never opens later than the first frame.
export interface TelemetryNoticeRead {
  kind: TelemetryNoticeKind;
  /** The machine's answer, or null: not asked (spent), not answered, failed, or too late for this load. */
  view: TelemetryView | null;
  /** The list waits: a first read is on its way and the bound has not passed. */
  held: boolean;
}

/** The last answer this page session got, or null before the first. */
let known: TelemetryView | null = null;

/** Test seam: forget the session's answer, as a fresh page load would. */
export function __resetTelemetryRead(): void {
  known = null;
}

/** `enabled` false reads nothing: the caller was handed a read by its route and draws from that. */
export function useTelemetryNoticeRead(enabled = true): TelemetryNoticeRead {
  const kind = useTelemetryNoticeKind();
  const asks = enabled && kind !== "none";
  const [view, setView] = useState<TelemetryView | null>(known);
  // Whether this mount began with nothing to draw from: only then does the list wait.
  const [cold] = useState(known === null);
  const [over, setOver] = useState(false);
  // True while the hold is in force: an answer that lands in it is shown, one that lands after it opens nothing.
  const holding = useRef(cold);

  useEffect(() => {
    if (!asks) return;
    const ac = new AbortController();
    const timer = setTimeout(() => {
      holding.current = false;
      setOver(true);
    }, CALM_HOLD_MS);
    void (async () => {
      try {
        const answer = await fetchTelemetry(ac.signal);
        if (ac.signal.aborted) return;
        known = answer;
        // Past the hold, an answer may close the notice; it may not open one above a list that has painted.
        if (holding.current || !shouldShowTelemetryNotice({ kind, view: answer })) setView(answer);
      } catch {
        // No read, no notice. Settings still holds the card.
      } finally {
        // A read the cleanup aborted belongs to a mount that has gone (or restarted its own).
        if (!ac.signal.aborted) {
          clearTimeout(timer);
          holding.current = false;
          setOver(true);
        }
      }
    })();
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [asks, kind]);

  return { kind, view, held: asks && cold && !over };
}
