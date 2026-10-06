// THE FREEZE (ADR 0071 point 3, ADR 0063), as a plain object a component keeps in a setup variable:
// web/src/hooks/use-frozen-ranks.ts without React. The order the operator asked for is READ ONCE and
// held, so a poll repaints a row where it stands and never moves it. A reading is taken:
//
//   - on the first `ranks()` call (the list opened);
//   - when the order passed in differs from the one the reading answers (the operator tapped another
//     segment);
//   - after `reread()` (the operator tapped the segment already selected, or the page came back);
//   - once, when the reading in force was taken over an empty herd and panes have since arrived (a
//     cold boot painted before its first snapshot; nothing was ranked, so nothing moves).
//
// Never on a poll. A pane the reading does not know ranks LAST (`inRankOrder`), so one that opens
// while the list is up arrives at the end and pushes no row out from under a thumb.
import { activityRanks, cacheRanks, type PaneOrder } from "./pane-order";
import type { AgentView } from "@web/lib/types";

const NO_RANKS: ReadonlyMap<string, number> = new Map();

export interface FrozenRanks {
  /** The reading in force for `order` over `panes`, taking a new one only on the rules above. */
  ranks(order: PaneOrder, panes: readonly AgentView[]): ReadonlyMap<string, number>;
  /** Ask for a new reading on the next `ranks()`. Call it from an operator's act, never a poll. */
  reread(): void;
}

export function createFrozenRanks(now: () => number = Date.now): FrozenRanks {
  let reading: { order: PaneOrder; ranks: ReadonlyMap<string, number> } | null = null;
  let stale = true;
  const read = (order: PaneOrder, panes: readonly AgentView[]): ReadonlyMap<string, number> => {
    if (order === "place") return NO_RANKS;
    return order === "activity" ? activityRanks(panes) : cacheRanks(panes, now());
  };
  return {
    ranks(order, panes) {
      const emptyFirst = reading !== null && order !== "place" && reading.ranks.size === 0 && panes.length > 0;
      if (stale || reading === null || reading.order !== order || emptyFirst) {
        reading = { order, ranks: read(order, panes) };
        stale = false;
      }
      return reading.ranks;
    },
    reread() {
      stale = true;
    },
  };
}
