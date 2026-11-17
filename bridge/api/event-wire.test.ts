// The API's `events` contract (decision 2): the exact JSON of each event type, pinned here apart from a
// trick's trigger shape. Invented data only.

import { describe, expect, test } from "bun:test";

import { EventBus } from "../events/bus.ts";
import { encodeSessionId } from "../events/session-id.ts";
import { wireEvent } from "./event-wire.ts";

const KEYS = ["v", "id", "cursor", "ts", "type", "machine", "session", "data"];
const SESSION = encodeSessionId({ machine: "inst-test-a1", paneId: "w1:p2", instance: "k3f9" });

function bus(maxCount = 2048): EventBus {
  return new EventBus({ machine: () => "inst-test-a1", bootId: "boot1", now: () => Date.parse("2026-11-17T10:00:00Z"), maxCount });
}

describe("the events wire shape", () => {
  test("session.status, turn.end and ask.open: exactly the eight keys, ids and states only", () => {
    const b = bus();
    b.publish({ type: "session.status", session: SESSION, data: { state: "working" } });
    b.publish({ type: "turn.end", session: SESSION });
    b.publish({ type: "ask.open", session: SESSION });
    const wire = b.since("boot1.0").events.map(wireEvent);
    for (const event of wire) expect(Object.keys(event)).toEqual(KEYS);
    expect(JSON.parse(JSON.stringify(wire))).toEqual([
      { v: 1, id: "evt_boot1.1", cursor: "boot1.1", ts: "2026-11-17T10:00:00.000Z", type: "session.status", machine: "inst-test-a1", session: SESSION, data: { state: "working" } },
      { v: 1, id: "evt_boot1.2", cursor: "boot1.2", ts: "2026-11-17T10:00:00.000Z", type: "turn.end", machine: "inst-test-a1", session: SESSION, data: {} },
      { v: 1, id: "evt_boot1.3", cursor: "boot1.3", ts: "2026-11-17T10:00:00.000Z", type: "ask.open", machine: "inst-test-a1", session: SESSION, data: {} },
    ]);
  });

  test("gap: a cursor older than the buffer, passed through with its reason and no session", () => {
    const b = bus(2);
    for (let i = 0; i < 4; i += 1) b.publish({ type: "turn.end", session: SESSION });
    const [first, ...rest] = b.since("boot1.0").events.map(wireEvent);
    expect(first).toMatchObject({ v: 1, type: "gap", session: null, data: { reason: "evicted" }, cursor: "boot1.2" });
    expect(Object.keys(first!)).toEqual(KEYS);
    expect(rest.map((event) => event.cursor)).toEqual(["boot1.3", "boot1.4"]);
  });

  test("reset: a cursor of another start, or no cursor at all, with its reason", () => {
    const b = bus();
    b.publish({ type: "turn.end", session: SESSION });
    expect(wireEvent(b.since("other.5").events[0]!)).toMatchObject({ type: "reset", session: null, data: { reason: "other-boot" } });
    expect(wireEvent(b.since("not a cursor").events[0]!)).toMatchObject({ type: "reset", session: null, data: { reason: "unreadable" } });
  });
});
