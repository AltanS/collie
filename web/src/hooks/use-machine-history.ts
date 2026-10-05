import { useEffect, useRef, useState } from "react";

import { useVisibleInterval } from "@/hooks/use-visible-interval";
import { fetchMachineHistory } from "@/lib/api";
import { isAbortError } from "@/lib/loaders";
import { mergeHistory, sinceOf } from "@/lib/machine-chart";
import type { MachineHistoryResponse } from "@/lib/types";

/** How often the open page re-reads the history: the series has one point per minute, so faster is waste. */
export const HISTORY_REFRESH_MS = 60_000;

export interface MachineHistoryState {
  /** The last good answer. Kept through a failed refresh, so a chart never blanks for one bad minute. */
  history: MachineHistoryResponse | null;
  /** The latest read failed. With `history` still set, the chart is stale, not missing. */
  failed: boolean;
}

/**
 * One machine's last 24 hours, for the detail page.
 *
 * It is NOT a route loader, on purpose: every active loader is re-run on every poll tick (4 to 6 s on
 * this page) and the day is up to 1440 points that change once a minute. It reads the whole day on
 * open (about 23 KB on the wire, gzipped), then once a minute while the page is visible only the
 * minutes from its newest point on (`?since=`, a few hundred bytes), merged in by `mergeHistory`.
 * The minute beat is `useVisibleInterval`: stopped outright while the page is hidden or behind the
 * idle lock, and it reads at once when the page comes back. A round starts only when the last one
 * has ended. `enabled` is false for an id the census does not know, which would only collect 404s,
 * and for an older machine, whose day is empty by definition.
 */
export function useMachineHistory(id: string, enabled: boolean): MachineHistoryState {
  const [state, setState] = useState<MachineHistoryState>({ history: null, failed: false });
  const held = useRef<MachineHistoryResponse | null>(null);
  const round = useRef<() => void>(() => {});
  useVisibleInterval(() => round.current(), HISTORY_REFRESH_MS, enabled);

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    let inFlight = false;
    held.current = null;

    async function load() {
      if (inFlight || controller.signal.aborted) return;
      inFlight = true;
      try {
        const answer = await fetchMachineHistory(id, controller.signal, sinceOf(held.current));
        const merged = mergeHistory(held.current, answer);
        held.current = merged;
        setState({ history: merged, failed: false });
      } catch (e) {
        if (isAbortError(e)) return;
        setState((prev) => (prev.failed ? prev : { history: prev.history, failed: true }));
      } finally {
        inFlight = false;
      }
    }

    round.current = () => void load();
    if (document.visibilityState === "visible") void load();
    return () => {
      controller.abort();
      round.current = () => {};
    };
  }, [id, enabled]);

  return state;
}
