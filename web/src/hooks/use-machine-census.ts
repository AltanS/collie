import { useEffect, useRef, useState } from "react";

import { useVisibleInterval } from "@/hooks/use-visible-interval";
import { fetchMachines, isApiErrorStatus } from "@/lib/api";
import { isAbortError, keepCensusIdentity, MACHINE_SPARK_MINUTES } from "@/lib/loaders";
import type { MachinesResponse } from "@/lib/types";

/**
 * How often the dashboard's Crew tab reads the census while it is on screen. A machine's numbers
 * move every 5 s on the lead while a page watches (bridge/machines.ts), but a card is a glance, and
 * its sparks move once a minute. 15 s keeps the numbers honest at a third of the requests.
 */
export const CREW_TAB_POLL_MS = 15_000;

/** What the Crew tab knows about the machines. */
export type MachineCensusState =
  | { kind: "loading" }
  /** The census, kept through a failed refresh: `failed` says the last read did not answer. */
  | { kind: "census"; census: MachinesResponse; failed: boolean }
  /** This collie keeps no machine list (a crew member answers 404). An answer, not a failure. */
  | { kind: "unavailable" }
  /** The first read failed and there is nothing kept to show. */
  | { kind: "error" };

/**
 * The last state, kept for the page session, so a return to the Crew tab shows the cards it last had
 * at once and the next read refreshes them quietly (the Changes tab's `lastCounts`, ADR 0066).
 */
let kept: MachineCensusState = { kind: "loading" };

/** Tests only: forget the kept census. */
export function resetMachineCensus(): void {
  kept = { kind: "loading" };
}

/**
 * The machines census with each card's last half hour (`?spark=30`), for the dashboard's Crew tab.
 *
 * The tab mounts this only while it is selected, so nothing here runs on any other tab (ADR 0066
 * point 4, the Changes tab's rule). On mount it reads at once, then once every
 * {@link CREW_TAB_POLL_MS} on `useVisibleInterval`'s beat: stopped outright while the page is
 * hidden or behind the idle lock, held while a finger is on the screen. A round starts only after
 * the last one ended. Back on screen it reads at once, and replaces a round still out from before
 * the page was hidden (a sleeping phone can leave one hanging). Unmounting aborts what is in flight.
 *
 * An answer equal to the last one keeps every object's identity (`keepCensusIdentity`), so the
 * state does not change and no card re-renders.
 */
export function useMachineCensus(): MachineCensusState {
  const [state, setState] = useState<MachineCensusState>(kept);
  const roundNow = useRef<() => void>(() => {});
  useVisibleInterval(() => roundNow.current(), CREW_TAB_POLL_MS);

  useEffect(() => {
    const life = new AbortController();
    let current: AbortController | null = null;

    const settle = (next: MachineCensusState) => {
      kept = next;
      setState((prev) => (sameState(prev, next) ? prev : next));
    };

    const round = async (replace = false): Promise<void> => {
      if (life.signal.aborted) return;
      if (current !== null) {
        if (!replace) return;
        current.abort();
      }
      const mine = new AbortController();
      current = mine;
      const stop = () => mine.abort();
      life.signal.addEventListener("abort", stop, { once: true });
      try {
        const census = keepCensusIdentity(await fetchMachines(mine.signal, { spark: MACHINE_SPARK_MINUTES }));
        if (!mine.signal.aborted) settle({ kind: "census", census, failed: false });
      } catch (e) {
        if (mine.signal.aborted || isAbortError(e)) return;
        if (isApiErrorStatus(e, 404)) settle({ kind: "unavailable" });
        // A failure keeps the cards it had, and says so; with none, it is the error card.
        else if (kept.kind === "census") settle({ ...kept, failed: true });
        else settle({ kind: "error" });
      } finally {
        life.signal.removeEventListener("abort", stop);
        if (current === mine) current = null;
      }
    };

    let outWhenHidden: AbortController | null = null;
    const onVisible = () => {
      if (document.visibilityState !== "visible") {
        outWhenHidden = current;
        return;
      }
      const stale = current !== null && current === outWhenHidden;
      outWhenHidden = null;
      void round(stale);
    };

    roundNow.current = () => void round();
    if (document.visibilityState === "visible") void round();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      life.abort();
      document.removeEventListener("visibilitychange", onVisible);
      roundNow.current = () => {};
    };
  }, []);

  return state;
}

function sameState(a: MachineCensusState, b: MachineCensusState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "census" && b.kind === "census") return a.census === b.census && a.failed === b.failed;
  return true;
}
