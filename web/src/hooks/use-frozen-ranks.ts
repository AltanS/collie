import { useCallback, useEffect, useState } from "react";

import { activityRanks, cacheRanks, type PaneOrder } from "@/lib/pane-order";
import type { AgentView } from "@/lib/types";

// THE FREEZE, in one place (ADR 0071 point 3, ADR 0063). The pane switcher and the dashboard both
// draw an order the operator asked for, and both owe the same promise: the clock is read ONCE, and a
// poll never moves a row. This hook is that promise, so the two surfaces cannot keep it two ways.
//
// A reading is taken:
//   - on mount;
//   - when `order` changes (the operator tapped another segment);
//   - when {@link FrozenRanks.reread} is called (the operator tapped the segment already selected,
//     which is the "look again" gesture);
//   - when the document becomes visible again, if the caller asked (`rereadOnVisible`): a dashboard
//     left in a background tab is stale by hours, and coming back to it IS opening it again. The
//     switcher is a sheet that unmounts on close, so it has no use for this and does not ask;
//   - once, when the first reading was taken over an empty herd and panes have since arrived. That is
//     not a re-sort of anything on screen, because nothing was ranked: a cold boot that painted
//     before its first snapshot would otherwise freeze the empty reading and never rank at all.
//
// It is never taken on a poll. A pane the reading does not know ranks LAST (`inRankOrder`), so one
// that opens while the list is up arrives at the end and pushes no row out from under a thumb.

/** No reading taken, which is what place order passes to `inRankOrder` to get the identity back. */
const NO_RANKS: ReadonlyMap<string, number> = new Map();

interface Reading {
  /** The order this reading answers. A different one means the operator tapped, so re-read. */
  order: PaneOrder;
  /** Which `reread()` call this reading answers. A newer call means the operator asked again. */
  generation: number;
  /** Row key against position. Empty for place order. */
  ranks: ReadonlyMap<string, number>;
}

function read(order: PaneOrder, panes: readonly AgentView[], generation: number): Reading {
  if (order === "place") return { order, generation, ranks: NO_RANKS };
  // `Date.now()` and not the cache clock's tick: this is the FREEZE, taken once when the operator
  // opens the list or taps. Subscribing to a clock that moves every second is the exact fault
  // ADR 0063 closes.
  return {
    order,
    generation,
    ranks: order === "activity" ? activityRanks(panes) : cacheRanks(panes, Date.now()),
  };
}

export interface FrozenRanks {
  /** Row key against position, from the reading in force. Empty for place order. */
  ranks: ReadonlyMap<string, number>;
  /** Take a new reading now. Call it from an operator's tap, never from a poll. */
  reread: () => void;
}

export function useFrozenRanks(
  order: PaneOrder,
  panes: readonly AgentView[],
  options: { rereadOnVisible?: boolean } = {},
): FrozenRanks {
  const { rereadOnVisible = false } = options;
  const [generation, setGeneration] = useState(0);
  // The state-adjustment-on-a-changed-prop shape, not a `useMemo` with a lie in its deps: the reading
  // must survive a poll and must NOT survive a tap, which is exactly the two things compared below.
  const [reading, setReading] = useState<Reading>(() => read(order, panes, generation));
  const firstOnAnEmptyHerd = order !== "place" && reading.ranks.size === 0 && panes.length > 0;
  if (reading.order !== order || reading.generation !== generation || firstOnAnEmptyHerd) {
    setReading(read(order, panes, generation));
  }

  const reread = useCallback(() => setGeneration((g) => g + 1), []);

  useEffect(() => {
    if (!rereadOnVisible || order === "place") return;
    const onVisible = () => {
      if (document.visibilityState === "visible") reread();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [rereadOnVisible, order, reread]);

  return { ranks: reading.ranks, reread };
}
