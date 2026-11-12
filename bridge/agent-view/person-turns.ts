// Person turns a view learns of from WalkyTalky (agent views SECURITY rule 6, review 9 R3). A message from
// the person (the phone's WalkyTalky, a Hill answer or tell) that was typed into one of this bridge's
// panes is a person turn in that session: a screen there, on a harness that reports no conversation,
// goes stale. A message from an agent is not the person, and a message that never reached a pane here
// (refused, held, inbox only, routed to another machine) is no turn here.

import type { LogRecord } from "../walky/log.ts";

/** What the listener needs: the log's receipts, the address of a pane here, and the view's note. */
export interface PersonTurnDoors {
  readonly log: { onReceipt(listener: (record: LogRecord) => void): void };
  readonly addressOf: (paneId: string, instance: string | null) => string;
  readonly note: (session: string) => void;
}

/** The session a receipt makes a person turn in, or null: an operator message that reached a pane here. */
export function personTurnOfReceipt(record: LogRecord, addressOf: PersonTurnDoors["addressOf"]): string | null {
  if (record.message.kind !== "operator") return null;
  // `unknown` may have been typed: a screen made stale for nothing costs a redraw, a missed turn a wrong tap.
  if (record.receipt.state !== "delivered" && record.receipt.state !== "unknown") return null;
  if (record.session === null || record.paneId === null) return null;
  return addressOf(record.paneId, record.instance);
}

/** Notes each person turn the WalkyTalky log records, as its receipt is written. */
export function listenPersonTurns(doors: PersonTurnDoors): void {
  doors.log.onReceipt((record) => {
    const session = personTurnOfReceipt(record, doors.addressOf);
    if (session !== null) doors.note(session);
  });
}
