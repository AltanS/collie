import type { HillDecision } from "./wire";

// THE HILL AS AN ENTRY ON THE TRICKS CARD (components/hill-entry.tsx): what the phone can know, from the
// list it already holds, before a person switches the Hill off. Pure: no store, no I/O.

/** How many Decisions wait on the Hill, and how many of them are Collie's own (a proposal, a new version, a carried trick). */
export interface HillWaiting {
  /** Every open Decision. The number the warning says. */
  count: number;
  /** The open Decisions Collie itself posted (`from.kind` "collie"). Only these arm the switch. */
  own: number;
}

/** The waiting Decisions of an open list. Closed ones are never in it. */
export function hillWaiting(open: readonly Pick<HillDecision, "from">[]): HillWaiting {
  return { count: open.length, own: open.filter((decision) => decision.from.kind === "collie").length };
}
