// A PANE'S OPEN ASKS AND ITS NEWEST TURN, ON THEIR WAY TO THE PHONE (ADR 0100 rule 1, ADR 0101 rule 1).
//
// `localSnapshot` calls this for every pane at serialise time. An adapter that raises asks as data
// (`MuxAdapter.openAsks`, the `durable` adapter) gives the pane an `asks` list with EVERY open ask, up
// to the adapter's own cap of 50 per pane: the push guard caps pushes, never what is shown, and the
// phone draws the first five with a row that opens the rest. An adapter that takes guarded
// controls (`MuxAdapter.paneTurn`, ADR 0101) gives the pane its newest `turnId` the same way. Every
// other pane is returned as it came, so its bytes do not move.

import type { MuxAdapter } from "../mux/types.ts";
import type { PaneWire } from "../types.ts";

/** `wire` with all its open asks, when its adapter has them. The same object when it has none. */
export function withOpenAsks(wire: PaneWire, adapter: Pick<MuxAdapter, "openAsks">): PaneWire {
  const open = adapter.openAsks?.(wire.paneId);
  return open === undefined ? wire : { ...wire, asks: [...open] };
}

/**
 * `wire` with the belt actions its program lists (M53 spec 07), when its adapter has them. The same object when it
 * does not, so no other pane's bytes move.
 */
export function withActions(wire: PaneWire, adapter: Pick<MuxAdapter, "paneActions">): PaneWire {
  const actions = adapter.paneActions?.(wire.paneId);
  return actions === undefined || actions.length === 0 ? wire : { ...wire, actions: [...actions] };
}

/**
 * `wire` with the pane's newest turn id (ADR 0101), when its adapter names turns, so the phone can
 * name it in a send or an abort. The same object when it does not, so no other pane's bytes move.
 */
export function withTurn(wire: PaneWire, adapter: Pick<MuxAdapter, "paneTurn">): PaneWire {
  const turnId = adapter.paneTurn?.(wire.paneId);
  return turnId === undefined ? wire : { ...wire, turnId };
}
