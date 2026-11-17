// THE LOCAL API'S EVENT SHAPE (M105 spec 03, decision 2). What `events` answers is built here from a
// bus event, by this module's own mapper, so the API's contract and a trick's `trigger` can change
// apart. event-wire.test.ts pins the exact keys.
//
//   { v: 1, id, cursor, ts, type, machine, session, data }
//
//   session.status   session: <ses_ id>, data: { state }   (idle, working, blocked, done, unknown)
//   turn.end         session: <ses_ id>, data: {}
//   ask.open         session: <ses_ id>, data: {}
//   gap              session: null,      data: { reason: "evicted" }
//   reset            session: null,      data: { reason: "other-boot" | "unreadable" }
//
// DELIVERY IS AT LEAST ONCE, PER MACHINE, WITH NO ORDER ACROSS SESSIONS (decision 6). A program that
// resumes from an older cursor gets events again, so it must be safe against a repeated event (key on
// `id`). Within one session the order is the order the bridge saw. A crew's lead does not merge its
// members' events: each machine answers its own.
//
// NEVER A SILENT HOLE (decision 5). The bridge keeps the last 2048 events, at most one hour old. A cursor
// older than that answers ONE `gap` first: events were lost between the cursor and the oldest one kept,
// so a program that counts on every event reads the state again (`sessions`). A cursor of an earlier
// bridge start, or text that is no cursor, answers ONE `reset` first: the bridge restarted and its
// sessions may have moved. Both are followed by every event kept, and the marker's own cursor sits just
// before the oldest of them.
//
// No text in an event (decision 4): ids and states only. The mapper copies the fields it knows, one by
// one, so a field the bus might gain does not reach the wire without a change here.

import type { BusEvent } from "../events/bus.ts";
import type { JsonObject } from "../json.ts";

/** One event as `events` answers it. */
export interface WireEvent extends JsonObject {
  readonly v: 1;
  readonly id: string;
  readonly cursor: string;
  readonly ts: string;
  readonly type: BusEvent["type"];
  readonly machine: string;
  readonly session: string | null;
  readonly data: JsonObject;
}

function dataOf(event: BusEvent): JsonObject {
  switch (event.type) {
    case "session.status":
      return { state: event.data.state };
    case "turn.end":
    case "ask.open":
      return {};
    case "gap":
    case "reset":
      return { reason: event.data.reason };
    default: {
      const never: never = event;
      throw new TypeError(`api: an unknown event type ${String(never)}`);
    }
  }
}

/** The API's shape of one bus event. */
export function wireEvent(event: BusEvent): WireEvent {
  return {
    v: 1,
    id: event.id,
    cursor: event.cursor,
    ts: event.ts,
    type: event.type,
    machine: event.machine,
    session: event.session,
    data: dataOf(event),
  };
}
