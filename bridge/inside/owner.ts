// One owner per ask kind (M99 spec 04, README decision 9, v2 "One owner per ask kind").
//
// A part that declared an ask kind owns that kind for its pane while it is bound, and only while the
// session can show its asks as today's hold card (a hold book). Then the screen reader makes no ask of
// that kind for the pane, and a settings hook's hold for it is let go at once with no decision: the
// part's own hold is the one card. When the part goes away (bye, idle, replaced by none) the kind falls
// back to the screen reader on the next read, with nothing to undo.

import type { HoldTarget } from "../surface/hold.ts";
import type { AskKind } from "./wire.ts";

/** What the rule reads about the pane's part: null when none is bound. */
export interface OwnerPart {
  readonly asks: ReadonlySet<AskKind>;
}

/** Whether the pane's part owns asks of `kind`. Pure. */
export function ownsAsk(part: OwnerPart | null, kind: AskKind, holdsCards: boolean): boolean {
  return holdsCards && part !== null && part.asks.has(kind);
}

/** A session's own hand-off of a hook's request (`HoldTarget.hold`). */
export type HoldHandOff = NonNullable<HoldTarget["hold"]>;

/**
 * The hook side of the rule: a settings hook's request for a pane whose part owns permissions is let go
 * at once, with no decision (the hook prints nothing and the part's hold is the one card). Any other
 * request goes to the session's hand-off unchanged.
 */
export function ownerHold(owns: (paneId: string) => boolean, take: HoldHandOff, log: (line: string) => void): HoldHandOff {
  return (paneId, request, conn, onClose) => {
    if (owns(paneId)) {
      conn.release();
      log(`[inside] hook hold let go pane=${paneId} tool=${request.tool}: the pane's part owns permissions`);
      return;
    }
    take(paneId, request, conn, onClose);
  };
}
