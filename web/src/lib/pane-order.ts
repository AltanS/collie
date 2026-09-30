// The order a pane list runs in, and the one exception ADR 0063 allows.
//
// ADR 0063 says no list is ordered by status: a pane's place is its machine, its space, its tab and
// its position in the tab, and a state change repaints a row but never moves it. That ADR closes
// with the one door it leaves open: "Revisit only with a surface that sorts by urgency on the
// operator's own request, a toggle the operator taps and watches. A list that re-sorts itself on a
// poll is the fault this closes."
//
// This module is that door, walked through carefully. Two rules keep it from re-opening the fault:
//
//   1. PLACE IS THE DEFAULT and nothing chooses activity for the operator. `coercePaneOrder` reads
//      anything it does not recognise as place, so an install that has never been told otherwise
//      behaves exactly as it did.
//   2. THE ORDER IS FROZEN WHILE THE LIST IS ON SCREEN. `activityRanks` takes one reading, and
//      `inRankOrder` then draws from that reading until something the OPERATOR did asks for a new
//      one. A pane that finishes a turn while the sheet is open repaints where it stands. It does
//      not climb past the row the thumb is already reaching for.
//
// Activity is not urgency, which is why this is a separate idea from `triage()` rather than a
// setting on it. Urgency asks "does a human have to act", and it stays a MARK on every surface.
// Activity asks "when did anything last happen here", which is the question you have when you want
// the pane you were just in.
import { paneRowKey } from "./hosts";
import type { JsonValue } from "./json";
import type { AgentView } from "./types";

export const PANE_ORDERS = ["place", "activity"] as const;
export type PaneOrder = (typeof PANE_ORDERS)[number];

/** A stored value as an order; anything unknown is the default, place. */
export function coercePaneOrder(raw: JsonValue | undefined): PaneOrder {
  return PANE_ORDERS.find((o) => o === raw) ?? "place";
}

/**
 * When anything last happened with this pane: the later of the agent's last status transition and
 * the last time the operator opened or drove the pane through Collie.
 *
 * THE LATER OF THE TWO, not `lastActiveAt` alone, and the ledger itself already reads them that way
 * — `bridge/activity.ts:162` prunes an entry on `now - Math.max(activeAt, seenAt)`, i.e. on exactly
 * this number. It is also the only reading that works for a bare shell: a shell has no agent and
 * therefore no status transitions, so `activeAt` never moves for it, while `seenAt` does. Sorting a
 * shell you used a minute ago below one you have never opened would be the wrong answer to the
 * question the operator asked.
 *
 * `0` when the bridge sent neither, which is every bridge older than the one that added them. Those
 * panes then rank last as a block, in place order, so activity order degrades to place order rather
 * than to noise.
 */
export function activityAt(pane: AgentView): number {
  return Math.max(pane.lastActiveAt ?? 0, pane.lastSeenAt ?? 0);
}

/**
 * ONE READING of the herd, as ranks: each pane's row key against its position, newest first.
 *
 * Call this when the operator opens the list or taps the toggle, and not again. Ties keep the order
 * they arrived in, which is place order on every surface that feeds this (ADR 0063 point 2), so two
 * panes with the same reading, and the whole block of panes with no reading at all, stay in the
 * order the multiplexer has them in.
 */
export function activityRanks(panes: readonly AgentView[]): Map<string, number> {
  const ranked = panes.toSorted((a, b) => activityAt(b) - activityAt(a));
  return new Map(ranked.map((p, i) => [paneRowKey(p), i]));
}

/**
 * Draw `panes` in the order a previous {@link activityRanks} reading put them in.
 *
 * A pane the reading does not know ranks LAST, keeping its place order among the other unknowns.
 * That is the rule that makes the freeze safe rather than merely stale: a pane that opened while the
 * sheet was up is still reachable, and it arrives at the end of the list where it cannot push a row
 * out from under a thumb that is already moving.
 *
 * An empty reading is therefore the identity, which is what place order passes in, so a caller does
 * not branch on the mode to decide whether to call this.
 */
export function inRankOrder(panes: readonly AgentView[], ranks: ReadonlyMap<string, number>): AgentView[] {
  const rankOf = (p: AgentView): number => ranks.get(paneRowKey(p)) ?? Number.MAX_SAFE_INTEGER;
  return panes.toSorted((a, b) => rankOf(a) - rankOf(b));
}
