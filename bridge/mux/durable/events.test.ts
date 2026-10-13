import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "../../json.ts";
import { logFileName } from "../../durable/log.ts";
import { DURABLE_LOG_DIR_OPTION, DURABLE_SOCKET_OPTION, DurableMux, durableMuxFactory, MIN_SNAPSHOT_GAP_MS } from "./adapter.ts";
import { CAPS } from "./clean.ts";
import type { DurableEventSink } from "./events.ts";
import { FakeDurableClock, FakeDurableProgram, hasHostileChars, hostileText, SOCKET_ONLY_SKIP, type FakeEvent } from "./fixture.ts";
import { parseEvents, type DurableEvent } from "./protocol.ts";

// THE EVENTS READER against a fake program that serves `GET /pane/:id/events` as WIRE.md 7.2 says.

/** A sink that remembers what the reader handed it, per pane, in order. */
class RecordingSink implements DurableEventSink {
  readonly calls: { paneId: string; events: readonly DurableEvent[] }[] = [];
  failWith: Error | null = null;

  apply(paneId: string, events: readonly DurableEvent[]): Promise<number> {
    if (this.failWith !== null) return Promise.reject(this.failWith);
    this.calls.push({ paneId, events });
    return Promise.resolve(events.length);
  }

  types(paneId: string): string[] {
    return this.calls.filter((call) => call.paneId === paneId).flatMap((call) => call.events.map((event) => event.type));
  }
}

const programs: FakeDurableProgram[] = [];

async function rig() {
  const program = await FakeDurableProgram.startWire();
  programs.push(program);
  const clock = new FakeDurableClock();
  const sink = new RecordingSink();
  const adapter = new DurableMux(program.wire(), clock, sink);
  const readLayout = async (): Promise<void> => {
    clock.advance(MIN_SNAPSHOT_GAP_MS + 50);
    await adapter.poll();
  };
  /** Read the layout, then the events of every pane that moved. */
  const sync = async (): Promise<readonly string[]> => {
    await readLayout();
    return adapter.syncEvents();
  };
  const eventRequests = (paneId: string): string[] =>
    program.requests
      .filter((request) => request.path.endsWith(`/pane/${paneId}/events`))
      .map((request) => request.search);
  return { program, adapter, clock, sink, readLayout, sync, eventRequests };
}

afterEach(async () => {
  for (const program of programs.splice(0)) await program.close();
});

const PANE = "conv-01";

function item(id: string, text: string, kind = "reply"): FakeEvent {
  return { type: "item", item: { id, kind, text } };
}

describe("a plain events read", () => {
  test("a pane read for the first time asks after=0 on the current epoch, and the sink gets its events", async () => {
    const { program, sink, sync, eventRequests } = await rig();
    program.appendEvent(PANE, item("i1", "hello", "user"));
    program.appendEvent(PANE, item("i2", "hi there"));

    const changed = await sync();

    expect(eventRequests(PANE)).toEqual([`?after=0&epoch=${program.epoch}`]);
    expect(sink.types(PANE)).toEqual(["item", "item"]);
    expect(changed).toContain(PANE);
  });

  test("the next read asks after the cursor it got, and only for a pane whose rev moved", async () => {
    const { program, sync, eventRequests } = await rig();
    program.appendEvent(PANE, item("i1", "one"));
    program.appendEvent(PANE, item("i2", "two"));
    await sync();

    // Nothing moved: the same epoch and rev, so no events request at all.
    await sync();
    expect(eventRequests(PANE)).toHaveLength(1);

    program.appendEvent(PANE, item("i3", "three"));
    await sync();
    expect(eventRequests(PANE)).toEqual([`?after=0&epoch=${program.epoch}`, `?after=2&epoch=${program.epoch}`]);
  });

  test("every pane in the layout is read once when the rev moves, and a pane the layout lacks is not", async () => {
    const { program, sync, eventRequests } = await rig();
    program.appendEvent(PANE, item("i1", "one"));
    await sync();
    for (const id of ["conv-01", "conv-02", "conv-03", "conv-04", "conv-05"]) expect(eventRequests(id)).toHaveLength(1);
    expect(eventRequests("conv-99")).toHaveLength(0);
  });

  test("the events read never runs on the snapshot read's path: poll() makes no events request", async () => {
    const { program, readLayout, eventRequests } = await rig();
    program.appendEvent(PANE, item("i1", "one"));
    await readLayout();
    expect(eventRequests(PANE)).toHaveLength(0);
  });
});

describe("more", () => {
  test("a reply that stopped early is followed at once, from its next cursor, until the pane is caught up", async () => {
    const { program, sink, sync, eventRequests } = await rig();
    program.eventsPerReply = 2;
    for (let n = 1; n <= 5; n += 1) program.appendEvent(PANE, item(`i${String(n)}`, `m${String(n)}`));

    await sync();

    const epoch = program.epoch;
    expect(eventRequests(PANE)).toEqual([`?after=0&epoch=${epoch}`, `?after=2&epoch=${epoch}`, `?after=4&epoch=${epoch}`]);
    expect(sink.types(PANE)).toEqual(["item", "item", "item", "item", "item"]);
  });

  test("a program that never stops saying more does not hold the pass: the pane is read again next time", async () => {
    const { program, sync, eventRequests } = await rig();
    program.override = (path) =>
      path.endsWith(`/pane/${PANE}/events`)
        ? new Response(JSON.stringify({ epoch: program.epoch, events: [], next: 0, more: true }), {
            headers: { "content-type": "application/json" },
          })
        : undefined;
    await sync();
    expect(eventRequests(PANE).length).toBe(20);
    // Not complete, so the next pass tries the pane again even though the rev did not move.
    await sync();
    expect(eventRequests(PANE).length).toBe(40);
  });
});

describe("reset", () => {
  test("a cursor older than the tail gets the whole current view, with the markers around it", async () => {
    const { program, sink, sync, eventRequests } = await rig();
    program.tailLimit = 3;
    program.appendEvent(PANE, item("i1", "one"));
    program.appendEvent(PANE, item("i2", "two"));
    await sync();

    // Eight more events: the tail now starts at 7, past the reader's cursor of 2.
    for (let n = 3; n <= 10; n += 1) program.appendEvent(PANE, item(`i${String(n)}`, `m${String(n)}`));
    sink.calls.length = 0;
    await sync();

    expect(eventRequests(PANE).at(-1)).toBe(`?after=2&epoch=${program.epoch}`);
    const types = sink.types(PANE);
    expect(types[0]).toBe("reset");
    expect(types.at(-1)).toBe("synced");
    expect(types.filter((type) => type === "item")).toHaveLength(10);
    expect(types.at(-2)).toBe("state");
  });

  test("a reset view lists each item in its latest version, in order of first appearance", async () => {
    const { program, sink, sync } = await rig();
    program.tailLimit = 1;
    program.appendEvent(PANE, item("a", "first"));
    program.appendEvent(PANE, item("b", "second"));
    program.appendEvent(PANE, item("a", "first, edited"));
    await sync();
    const texts = sink.calls
      .flatMap((call) => call.events)
      .flatMap((event) => (event.type === "item" && event.item.kind !== "tool" ? [event.item.text] : []));
    expect(texts).toEqual(["first, edited", "second"]);
  });

  test("a new epoch is read with the OLD epoch and cursor, and the reset reply moves the cursor to the new epoch", async () => {
    const { program, sink, sync, eventRequests } = await rig();
    program.appendEvent(PANE, item("i1", "one"));
    program.appendEvent(PANE, item("i2", "two"));
    await sync();
    const oldEpoch = program.epoch;

    program.restart();
    program.appendEvent(PANE, item("i3", "after the restart"));
    sink.calls.length = 0;
    await sync();

    expect(program.epoch).not.toBe(oldEpoch);
    expect(eventRequests(PANE).at(-1)).toBe(`?after=2&epoch=${oldEpoch}`);
    const types = sink.types(PANE);
    expect(types[0]).toBe("reset");
    expect(types.filter((type) => type === "item")).toHaveLength(3);

    // The cursor is on the new epoch now: the next read is plain.
    program.appendEvent(PANE, item("i4", "later"));
    sink.calls.length = 0;
    await sync();
    expect(eventRequests(PANE).at(-1)).toBe(`?after=${String(program.eventCount(PANE) - 1)}&epoch=${program.epoch}`);
    expect(sink.types(PANE)).toEqual(["item"]);
  });

  test("a pane the reader never read, on a program that already restarted, starts at after=0 on the current epoch", async () => {
    const { program, sync, eventRequests } = await rig();
    program.restart();
    program.appendEvent(PANE, item("i1", "one"));
    await sync();
    expect(eventRequests(PANE)).toEqual([`?after=0&epoch=${program.epoch}`]);
  });

  test("a view cut to the newest items counts the rest in trimmed, and the reader applies what it was given", async () => {
    const { program, sink, sync } = await rig();
    program.tailLimit = 1;
    program.viewItemCap = 3;
    for (let n = 1; n <= 5; n += 1) program.appendEvent(PANE, item(`i${String(n)}`, `m${String(n)}`));

    await sync();

    const ids = sink.calls
      .flatMap((call) => call.events)
      .flatMap((event) => (event.type === "item" ? [event.item.id] : []));
    expect(ids).toEqual(["i3", "i4", "i5"]);

    const parsed = parseEvents(await fetchEvents(program, PANE, 0, program.epoch));
    expect(parsed.ok && parsed.value.trimmed).toBe(2);
    expect(parsed.ok && parsed.value.reset).toBe(true);
  });
});

/** The body of a plain events read, as the program sent it. */
async function fetchEvents(program: FakeDurableProgram, paneId: string, after: number, epoch: string): Promise<string> {
  const route = `/session/v1/pane/${paneId}/events?after=${String(after)}&epoch=${epoch}`;
  const response = await program.rawGet(route, { "x-collie-session": "1" });
  return response.text();
}

describe("what stops a pass", () => {
  test("a pane the program does not have answers 404 and is skipped, and the others are still read", async () => {
    const { program, sync, eventRequests } = await rig();
    program.override = (path) =>
      path.endsWith("/pane/conv-02/events") ? new Response(JSON.stringify({ code: "no-such-pane" }), { status: 404 }) : undefined;
    await sync();
    expect(eventRequests("conv-02")).toHaveLength(1);
    expect(eventRequests("conv-03")).toHaveLength(1);
  });

  test("a 503 ends the pass and the pane is read again once the program answers", async () => {
    const { program, sink, sync, eventRequests } = await rig();
    program.appendEvent(PANE, item("i1", "one"));
    program.override = (path) =>
      path.endsWith(`/pane/${PANE}/events`) ? new Response(JSON.stringify({ code: "starting" }), { status: 503 }) : undefined;
    await sync();
    expect(sink.calls).toHaveLength(0);
    // The pass stopped at the first pane: no other pane was asked.
    expect(eventRequests("conv-02")).toHaveLength(0);

    program.override = null;
    await sync();
    expect(sink.types(PANE)).toEqual(["item"]);
  });

  test("a 400 forgets the cursor, and the pane is read again from the start", async () => {
    const { program, sink, sync, eventRequests } = await rig();
    program.appendEvent(PANE, item("i1", "one"));
    await sync();
    let calls = 0;
    program.override = (path) => {
      if (!path.endsWith(`/pane/${PANE}/events`)) return undefined;
      calls += 1;
      return calls === 1 ? new Response(JSON.stringify({ code: "bad-cursor" }), { status: 400 }) : undefined;
    };
    program.appendEvent(PANE, item("i2", "two"));
    await sync();
    await sync();
    // After the 400 the cursor was gone, so the retry asked after=0 and the plain read returned both.
    expect(eventRequests(PANE).at(-1)).toBe(`?after=0&epoch=${program.epoch}`);
    expect(sink.types(PANE).filter((type) => type === "item")).toHaveLength(3);
  });

  test("an unreadable reply ends the pass without throwing", async () => {
    const { program, adapter, sync } = await rig();
    program.override = (path) => (path.endsWith("/events") ? new Response("not json", { status: 200 }) : undefined);
    await sync();
    await expect(adapter.syncEvents()).resolves.toEqual([]);
  });

  test("a sink that cannot write leaves the cursor where it was: the same events are read again", async () => {
    const { program, sink, sync, eventRequests } = await rig();
    program.appendEvent(PANE, item("i1", "one"));
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      sink.failWith = new Error("disk full");
      await sync();
      sink.failWith = null;
      await sync();
    } finally {
      console.warn = warn;
    }
    expect(eventRequests(PANE)).toEqual([`?after=0&epoch=${program.epoch}`, `?after=0&epoch=${program.epoch}`]);
    expect(sink.types(PANE)).toEqual(["item"]);
  });
});

describe("parseEvents (WIRE.md sections 4, 6 and 7.2)", () => {
  const EPOCH = "e4b1c7a09d3f5e826b7a1c0d94f3e582";
  const body = (events: JsonValue[], extra: JsonObject = {}): string =>
    JSON.stringify({ epoch: EPOCH, next: events.length, events, ...extra });

  test("every event type of the wire is read", () => {
    const parsed = parseEvents(
      body([
        { type: "item", item: { id: "i1", kind: "user", text: "hi", ts: "2026-10-12T09:30:00.000Z" } },
        { type: "item", item: { id: "i2", kind: "tool", tool: { kind: "other", name: "write_note", summary: "path=/x", output: "ok" }, status: "done" } },
        { type: "remove", id: "i1" },
        {
          type: "ask",
          ask: { id: "a1", kind: "permission", toolCallId: "c1", revision: 1, title: "t", itemId: "i2", options: [{ id: "allow", label: "Allow", effect: "allow" }] },
        },
        { type: "ask-closed", askId: "a1", by: "phone", waitedMs: 1200 },
        { type: "state", state: "idle" },
        { type: "settled", inputId: "in1", requestId: "r1", status: "unanswered", reason: "aborted" },
        { type: "reset" },
        { type: "synced" },
      ]),
    );
    expect(parsed.ok && parsed.value.events.map((event) => event.type)).toEqual([
      "item",
      "item",
      "remove",
      "ask",
      "ask-closed",
      "state",
      "settled",
      "reset",
      "synced",
    ]);
  });

  test("an unknown event type, an item of an unknown kind and a broken id are dropped alone", () => {
    const parsed = parseEvents(
      body([
        { type: "future-thing", x: 1 },
        { type: "item", item: { id: "i1", kind: "hologram", text: "x" } },
        { type: "item", item: { id: "has space", kind: "reply", text: "x" } },
        { type: "item", item: { id: "i3", kind: "tool", tool: { name: "t", summary: "s" }, status: "melting" } },
        { type: "item", item: { id: "ok", kind: "reply", text: "kept" } },
      ]),
    );
    expect(parsed.ok && parsed.value.events).toEqual([{ type: "item", item: { id: "ok", ts: undefined, kind: "reply", text: "kept" } }]);
  });

  test("item text is cleaned of controls and direction marks and cut at its byte cap", () => {
    const parsed = parseEvents(body([{ type: "item", item: { id: "i1", kind: "reply", text: hostileText("evil", CAPS.itemText + 10) } }]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const event = parsed.value.events[0];
    if (event?.type !== "item" || event.item.kind === "tool") throw new Error("expected a text item");
    expect(hasHostileChars(event.item.text)).toBe(false);
    expect(Buffer.byteLength(event.item.text)).toBeLessThanOrEqual(CAPS.itemText);
    expect(event.item.text.endsWith("…")).toBe(true);
  });

  test("an item keeps newlines in its text, and a ts that is not ISO, or is over its cap, reads as absent", () => {
    const parsed = parseEvents(
      body([
        { type: "item", item: { id: "i1", kind: "reply", text: "a\nb", ts: "yesterday" } },
        { type: "item", item: { id: "i2", kind: "reply", text: "x", ts: `2026-10-12T09:30:00.000Z${" ".repeat(60)}` } },
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const [first, second] = parsed.value.events;
    expect(first?.type === "item" && first.item.kind !== "tool" && first.item.text).toBe("a\nb");
    expect(first?.type === "item" && first.item.ts).toBeUndefined();
    expect(second?.type === "item" && second.item.ts).toBeUndefined();
  });

  test("a plain reply over 1000 events is refused, and a reset reply may carry its whole view", () => {
    const many = Array.from({ length: 1001 }, (_, n) => ({ type: "item", item: { id: `i${String(n)}`, kind: "reply", text: "x" } }));
    expect(parseEvents(body(many)).ok).toBe(false);
    expect(parseEvents(body(many, { reset: true })).ok).toBe(true);
  });

  test("a body without a usable epoch, next or list is not a reply", () => {
    expect(parseEvents("nope").ok).toBe(false);
    expect(parseEvents(JSON.stringify({ epoch: EPOCH, events: [] })).ok).toBe(false);
    expect(parseEvents(JSON.stringify({ epoch: "bad id", next: 0, events: [] })).ok).toBe(false);
    expect(parseEvents(JSON.stringify({ epoch: EPOCH, next: 0, events: "no" })).ok).toBe(false);
  });

  test("an ask-closed from a stranger reads as stopped, and a settled reason is capped", () => {
    const parsed = parseEvents(
      body([
        { type: "ask-closed", askId: "a1", by: "somebody" },
        { type: "settled", inputId: "in1", status: "unanswered", reason: "r".repeat(500) },
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const [closed, settled] = parsed.value.events;
    expect(closed?.type === "ask-closed" && closed.by).toBe("stopped");
    expect(settled?.type === "settled" && Buffer.byteLength(settled.reason ?? "")).toBeLessThanOrEqual(CAPS.settledReason);
  });
});

describe("where the events go", () => {
  test("an adapter built without a log asks the program for no events at all", async () => {
    const program = await FakeDurableProgram.startWire();
    programs.push(program);
    const clock = new FakeDurableClock();
    const adapter = new DurableMux(program.wire(), clock);
    program.appendEvent(PANE, item("i1", "one"));
    clock.advance(MIN_SNAPSHOT_GAP_MS + 50);
    await adapter.poll();
    expect(await adapter.syncEvents()).toEqual([]);
    expect(program.requests.filter((request) => request.path.endsWith("/events"))).toEqual([]);
  });

  // Socket only: the factory is handed a socket path.
  test.skipIf(SOCKET_ONLY_SKIP)("the registry's factory builds the pane log from the target's log folder: one file per pane, even for a pane with no events", async () => {
    const program = await FakeDurableProgram.start();
    programs.push(program);
    const dir = await mkdtemp(join(tmpdir(), "collie-durable-factory-"));
    try {
      const adapter = durableMuxFactory.create({
        endpoint: "",
        timeoutMs: 1000,
        options: { [DURABLE_SOCKET_OPTION]: program.socketPath, [DURABLE_LOG_DIR_OPTION]: join(dir, "durable") },
      });
      program.appendEvent(PANE, item("i1", "one"));
      if (!(adapter instanceof DurableMux)) throw new Error("expected the durable adapter");
      await adapter.poll();
      expect(await adapter.syncEvents()).toEqual([PANE]);
      const names = await readdir(join(dir, "durable"));
      expect(names.toSorted()).toEqual(
        ["conv-01", "conv-02", "conv-03", "conv-04", "conv-05"].map((id) => logFileName(id)).toSorted(),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
