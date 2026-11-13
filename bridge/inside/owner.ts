// One owner per dialog (M99 spec 04, README decision 9, v2 "One owner per ask kind"), as the lead
// decided after the review: a part owns a permission dialog only while its live hold for that pane
// and that dialog exists (`PartAsks.ownsDialog`). Then a settings hook's request for the same dialog
// is let go at once with no decision: the part's hold is the one card. Any other request, a subagent's
// included, goes to the session's hand-off unchanged. A hook that came first keeps its hold until the
// part's hold opens; the hold book then ends it with no decision (one card per pane).

import type { HoldTarget } from "../surface/hold.ts";

/** A session's own hand-off of a hook's request (`HoldTarget.hold`). */
export type HoldHandOff = NonNullable<HoldTarget["hold"]>;

/** The hook side of the rule. `owns` answers for one request: the pane, and the dialog it names. */
export function ownerHold(owns: (paneId: string, request: Parameters<HoldHandOff>[1]) => boolean, take: HoldHandOff, log: (line: string) => void): HoldHandOff {
  return (paneId, request, conn, onClose) => {
    if (owns(paneId, request)) {
      conn.release();
      log(`[inside] hook hold let go pane=${paneId} tool=${request.tool}: a part holds this dialog`);
      return;
    }
    take(paneId, request, conn, onClose);
  };
}
