import { useEffect, useState } from "react";

import { fetchMachineHistory } from "@/lib/api";
import { isAbortError } from "@/lib/loaders";
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
 * It is NOT a route loader, on purpose: every active loader is re-run on every poll tick (1.5 s while
 * the page is in use) and this answer is up to 1440 points that change once a minute. It reads on open,
 * then once a minute while the page is visible, and once more when the page returns to the foreground
 * after a longer gap (a hidden page runs no timer worth trusting). `enabled` is false for an id the
 * census does not know, which would only collect 404s.
 */
export function useMachineHistory(id: string, enabled: boolean): MachineHistoryState {
  const [state, setState] = useState<MachineHistoryState>({ history: null, failed: false });

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    let lastAt = 0;

    async function load() {
      lastAt = Date.now();
      try {
        const history = await fetchMachineHistory(id, controller.signal);
        setState({ history, failed: false });
      } catch (e) {
        if (isAbortError(e)) return;
        setState((prev) => ({ history: prev.history, failed: true }));
      }
    }

    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, HISTORY_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastAt >= HISTORY_REFRESH_MS) void load();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [id, enabled]);

  return state;
}
