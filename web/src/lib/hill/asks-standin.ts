// STAND-INS FOR THE WIRE OF ASKS BUILD 2 (2026-11-23). The bridge worker lands the wire names in `wire.ts` and
// `reader.ts` (BUILD-2-WIRE.md): `HillAsk.mark` and `confirmedAt`, `HillOption.cost`, the reserved intent `own` and the
// reason of a cleared conversation. Until that commit is merged the phone pages read them from here, under the SAME
// names and shapes. After the merge this file is deleted and each import points at `./wire`.

import type { HillAsk, HillOption } from "./wire";

/** What the bridge knows of an ask's freshness: no prompt since it was posted, seen and still open, or not checked. */
export type HillAskMark = "fresh" | "carried" | "unchecked";
export const HILL_ASK_MARKS: readonly HillAskMark[] = ["fresh", "carried", "unchecked"];

/** The fixed free-text answer of an ask with options. */
export const HILL_OWN_ANSWER = "own";
export const HILL_OWN_ANSWER_LABEL = "Your own answer";

/** The closed reason of an ask the bridge closed because the person ran `/clear` in its session. */
export const HILL_ASK_CLEARED = "conversation cleared";

/** The mark of an ask: what the bridge sent, else `fresh` without `confirmedAt` and `carried` with it (a record from before the mark). */
export function askMarkOf(ask: Pick<HillAsk, "confirmedAt"> & { mark?: HillAskMark }): HillAskMark {
  if (ask.mark !== undefined) return ask.mark;
  return ask.confirmedAt === undefined ? "fresh" : "carried";
}

/** What an option costs (`--cost`), or undefined when the agent sent none. */
export function optionCost(option: HillOption & { cost?: string }): string | undefined {
  const cost = option.cost;
  return cost === undefined || cost.trim() === "" ? undefined : cost;
}
