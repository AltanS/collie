// A PANE'S OPEN ASKS AND ITS NEWEST TURN, ON THEIR WAY TO THE PHONE (ADR 0100 rule 1, ADR 0101 rule 1).
//
// `localSnapshot` calls this for every pane at serialise time. An adapter that raises asks as data
// (`MuxAdapter.openAsks`, the `durable` adapter) gives the pane an `asks` list, capped at the five
// oldest by the guard's open cap, and a `moreAsks` count for the rest. An adapter that takes guarded
// controls (`MuxAdapter.paneTurn`, ADR 0101) gives the pane its newest `turnId` the same way. Every
// other pane is returned as it came, so its bytes do not move.

import type { MuxAdapter } from "../mux/types.ts";
import type { PaneWire } from "../types.ts";
import { DEFAULT_GUARD_LIMITS, openCap, type GuardLimits } from "./guard.ts";

/** `wire` with its open asks, when its adapter has them. The same object when it has none. */
export function withOpenAsks(
  wire: PaneWire,
  adapter: Pick<MuxAdapter, "openAsks">,
  limits: GuardLimits = DEFAULT_GUARD_LIMITS,
): PaneWire {
  const open = adapter.openAsks?.(wire.paneId);
  if (open === undefined) return wire;
  const { shown, more } = openCap(open, limits);
  return more > 0 ? { ...wire, asks: shown, moreAsks: more } : { ...wire, asks: shown };
}

/**
 * `wire` with the pane's newest turn id (ADR 0101), when its adapter names turns, so the phone can
 * name it in a send or an abort. The same object when it does not, so no other pane's bytes move.
 */
export function withTurn(wire: PaneWire, adapter: Pick<MuxAdapter, "paneTurn">): PaneWire {
  const turnId = adapter.paneTurn?.(wire.paneId);
  return turnId === undefined ? wire : { ...wire, turnId };
}
