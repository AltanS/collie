import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "../../json.ts";
import { cursorFileName, DurableLogs, logFileName } from "../../durable/log.ts";
import { parseDurableLog } from "../../journal/durable.ts";
import { DURABLE_LOG_DIR_OPTION, DURABLE_SOCKET_OPTION, DurableMux, durableMuxFactory, MIN_SNAPSHOT_GAP_MS } from "./adapter.ts";
import { CAPS, ITEM_RICH_BYTES } from "./clean.ts";
import type { DurableEventSink } from "./events.ts";
import { FakeDurableClock, FakeDurableProgram, hasHostileChars, hostileText, SOCKET_ONLY_SKIP, type FakeEvent } from "./fixture.ts";
import { parseEvents, parseLogRow, type DurableEvent } from "./protocol.ts";

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
/** Two bytes a character, so this is over the 32 KiB cap of a rich item. */
const CAPS_RICH = ITEM_RICH_BYTES;

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

describe("dropped items (WIRE.md 7.13)", () => {
  test("a pane that sends items the reader drops gets one log line per epoch, not one per item or per read", async () => {
    const { program, sync } = await rig();
    const said: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void said.push(args.map(String).join(" "));
    try {
      program.appendEvent(PANE, { type: "item", item: { id: "l1", kind: "link", href: "http://example.com/" } });
      program.appendEvent(PANE, { type: "item", item: { id: "l2", kind: "image", src: "x" } });
      program.appendEvent(PANE, item("i1", "kept"));
      await sync();
      program.appendEvent(PANE, { type: "item", item: { id: "l3", kind: "link", href: "javascript:x" } });
      await sync();
    } finally {
      console.warn = warn;
    }
    expect(said.filter((line) => line.includes(PANE) && line.includes("dropped"))).toHaveLength(1);
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
      .flatMap((event) => (event.type === "item" && "text" in event.item ? [event.item.text] : []));
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

  test("markdown, code and link items are read, cleaned and capped (WIRE.md 7.13)", () => {
    const parsed = parseEvents(
      body([
        { type: "item", item: { id: "m1", kind: "markdown", text: `# Title\n\n- one\n- two${String.fromCodePoint(0x202e)}` } },
        { type: "item", item: { id: "c1", kind: "code", lang: " typescript ", text: "const a = 1;\n" } },
        { type: "item", item: { id: "l1", kind: "link", href: "https://colliepwa.dev/docs/", label: " The docs " } },
        { type: "item", item: { id: "l2", kind: "link", href: "https://colliepwa.dev/" } },
        { type: "item", item: { id: "m2", kind: "markdown", text: "é".repeat(CAPS_RICH) } },
      ]),
    );
    const items = parsed.ok ? parsed.value.events.flatMap((event) => (event.type === "item" ? [event.item] : [])) : [];
    expect(items.slice(0, 4)).toEqual([
      { id: "m1", ts: undefined, kind: "markdown", text: "# Title\n\n- one\n- two" },
      { id: "c1", ts: undefined, kind: "code", lang: "typescript", text: "const a = 1;\n" },
      { id: "l1", ts: undefined, kind: "link", href: "https://colliepwa.dev/docs/", label: "The docs" },
      { id: "l2", ts: undefined, kind: "link", href: "https://colliepwa.dev/" },
    ]);
    const long = items[4];
    expect(long?.kind === "markdown" && Buffer.byteLength(long.text)).toBeLessThanOrEqual(ITEM_RICH_BYTES);
    expect(long?.kind === "markdown" && long.text.endsWith("…")).toBe(true);
  });

  test("partial rides on reply, thinking, notice and markdown only, requestId on user only (WIRE.md 7.15)", () => {
    const parsed = parseEvents(
      body([
        { type: "item", item: { id: "r", kind: "reply", text: "Hel", partial: true } },
        { type: "item", item: { id: "t", kind: "thinking", text: "hm", partial: true } },
        { type: "item", item: { id: "n", kind: "notice", text: "wait", partial: true } },
        { type: "item", item: { id: "m", kind: "markdown", text: "# A", partial: true } },
        { type: "item", item: { id: "f", kind: "reply", text: "done", partial: false } },
        { type: "item", item: { id: "s", kind: "reply", text: "odd", partial: "true" } },
        { type: "item", item: { id: "u", kind: "user", text: "hi", requestId: "req-1", partial: true } },
        { type: "item", item: { id: "u2", kind: "user", text: "hi", requestId: "has space" } },
        { type: "item", item: { id: "r2", kind: "reply", text: "x", requestId: "req-1" } },
        { type: "item", item: { id: "c", kind: "code", text: "x", partial: true } },
      ]),
    );
    const items = parsed.ok ? parsed.value.events.flatMap((event) => (event.type === "item" ? [event.item] : [])) : [];
    expect(items).toEqual([
      { id: "r", ts: undefined, kind: "reply", text: "Hel", partial: true },
      { id: "t", ts: undefined, kind: "thinking", text: "hm", partial: true },
      { id: "n", ts: undefined, kind: "notice", text: "wait", partial: true },
      { id: "m", ts: undefined, kind: "markdown", text: "# A", partial: true },
      { id: "f", ts: undefined, kind: "reply", text: "done" },
      { id: "s", ts: undefined, kind: "reply", text: "odd" },
      { id: "u", ts: undefined, kind: "user", text: "hi", requestId: "req-1" },
      { id: "u2", ts: undefined, kind: "user", text: "hi" },
      { id: "r2", ts: undefined, kind: "reply", text: "x" },
      { id: "c", ts: undefined, kind: "code", text: "x" },
    ]);
  });

  test("a code language that is not a plain name reads as none and the block stays, a label is cut to 120 characters", () => {
    const langs = ["", "a".repeat(25), "ts\n```", "c++ x", 7, null];
    const parsed = parseEvents(
      body([
        ...langs.map((lang, index) => ({ type: "item", item: { id: `c${String(index)}`, kind: "code", lang, text: "x" } })),
        { type: "item", item: { id: "l1", kind: "link", href: "https://example.com/", label: "é".repeat(300) } },
      ]),
    );
    const items = parsed.ok ? parsed.value.events.flatMap((event) => (event.type === "item" ? [event.item] : [])) : [];
    expect(items.slice(0, langs.length).map((entry) => entry.kind === "code" && entry.lang)).toEqual(langs.map(() => undefined));
    const link = items.at(-1);
    expect(link?.kind === "link" && [...(link.label ?? "")].length).toBe(120);
  });

  test("a link whose target is not https, or breaks the rule, drops the item alone, and the drop is counted", () => {
    const hrefs = [
      "http://example.com/",
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "//example.com/",
      "/docs",
      "https://",
      "https://user:pw@example.com/",
      "https://example.com/a b",
      `https://example.com/${"a".repeat(2100)}`,
      "https://exa\u200bmple.com/",
      42,
      null,
    ];
    const parsed = parseEvents(
      body([
        ...hrefs.map((href, index) => ({ type: "item", item: { id: `l${String(index)}`, kind: "link", href } })),
        { type: "item", item: { id: "ok", kind: "reply", text: "kept" } },
      ]),
    );
    expect(parsed.ok && parsed.value.events.map((event) => (event.type === "item" ? event.item.id : event.type))).toEqual(["ok"]);
    expect(parsed.ok && parsed.value.droppedItems).toBe(hrefs.length);
  });

  test("item text is cleaned of controls and direction marks and cut at its byte cap", () => {
    const parsed = parseEvents(body([{ type: "item", item: { id: "i1", kind: "reply", text: hostileText("evil", CAPS.itemText + 10) } }]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const event = parsed.value.events[0];
    if (event?.type !== "item" || !("text" in event.item)) throw new Error("expected a text item");
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
    expect(first?.type === "item" && "text" in first.item && first.item.text).toBe("a\nb");
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
      expect(names.filter((name) => name.endsWith(".jsonl")).toSorted()).toEqual(
        ["conv-01", "conv-02", "conv-03", "conv-04", "conv-05"].map((id) => logFileName(id)).toSorted(),
      );
      // The cursor is saved beside the log of the pane it moved on; a pane with nothing read keeps none.
      expect(names.filter((name) => name.endsWith(".cursor.json"))).toEqual([cursorFileName(PANE)]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("a reply that grows, through the reader into the pane log (WIRE.md 7.15)", () => {
  const grown = (id: string, text: string, partial: boolean): FakeEvent => ({ type: "item", item: partial ? { id, kind: "reply", text, partial: true } : { id, kind: "reply", text } });

  test("an item with a known id replaces the earlier one: the log and the chat hold ONE turn, never a row per version", async () => {
    const program = await FakeDurableProgram.startWire();
    programs.push(program);
    const dir = await mkdtemp(join(tmpdir(), "collie-durable-grow-"));
    try {
      const clock = new FakeDurableClock();
      const logs = new DurableLogs(join(dir, "durable"));
      const adapter = new DurableMux(program.wire(), clock, logs);
      const sync = async () => {
        clock.advance(MIN_SNAPSHOT_GAP_MS + 50);
        await adapter.poll();
        await adapter.syncEvents();
      };
      const turns = async () => parseDurableLog(await readFile(join(dir, "durable", logFileName(PANE)), "utf8")).filter((entry) => entry.uuid === "r1");

      program.appendEvent(PANE, { type: "item", item: { id: "u1", kind: "user", text: "go", requestId: "req-1" } });
      program.appendEvent(PANE, grown("r1", "Hel", true));
      await sync();
      expect((await turns()).map((entry) => entry.partial)).toEqual([true]);

      // Three writes by the program between two reads: only the newest is news.
      program.appendEvent(PANE, grown("r1", "Hello", true));
      program.appendEvent(PANE, grown("r1", "Hello, wor", true));
      program.appendEvent(PANE, grown("r1", "Hello, world", true));
      await sync();
      program.appendEvent(PANE, grown("r1", "Hello, world", false));
      await sync();

      const file = await readFile(join(dir, "durable", logFileName(PANE)), "utf8");
      const all = parseDurableLog(file);
      expect(all.map((entry) => entry.uuid)).toEqual(["u1", "r1"]); // one turn for the user line, one for the reply
      expect(all[0]?.requestId).toBe("req-1");
      expect(all[1]).not.toHaveProperty("partial");
      expect(all[1]?.parts[0]).toEqual({ kind: "text", text: "Hello, world" });
      // Rows for r1: the first poll's version, the second poll's newest, the final. Not six.
      expect(file.split("\n").filter((line) => line.includes('"id":"r1"'))).toHaveLength(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the saved cursor (M53 spec 11, WIRE.md 7.16)", () => {
  /** A bridge: an adapter with the pane logs of `folder`. A second one on the same folder is a bridge restart. */
  function bridge(program: FakeDurableProgram, folder: string) {
    const clock = new FakeDurableClock();
    const logs = new DurableLogs(folder);
    const adapter = new DurableMux(program.wire(), clock, logs);
    const sync = async (): Promise<readonly string[]> => {
      clock.advance(MIN_SNAPSHOT_GAP_MS + 50);
      await adapter.poll();
      return adapter.syncEvents();
    };
    return { adapter, logs, sync };
  }
  const eventReads = (program: FakeDurableProgram, from: number): string[] =>
    program.requests
      .slice(from)
      .filter((request) => request.path.endsWith(`/pane/${PANE}/events`))
      .map((request) => request.search);
  /** The item ids the log holds, one per row, in order: a repeat would show twice. */
  const loggedIds = async (folder: string): Promise<string[]> =>
    (await readFile(join(folder, logFileName(PANE)), "utf8"))
      .split("\n")
      .flatMap((line) => {
        const row = parseLogRow(line);
        return row?.k === "item" ? [row.item.id] : [];
      });

  test("cursor: a bridge restart goes on from the saved cursor: no read from 0, no duplicate row, no gap notice", async () => {
    const program = await FakeDurableProgram.startWire();
    programs.push(program);
    // The program keeps a short tail and a short view, so a read from 0 would be a trimmed reset with a gap.
    program.tailLimit = 3;
    program.viewItemCap = 2;
    const dir = await mkdtemp(join(tmpdir(), "collie-durable-cursor-"));
    try {
      const folder = join(dir, "durable");
      const first = bridge(program, folder);
      program.appendEvent(PANE, item("i1", "one"));
      program.appendEvent(PANE, item("i2", "two"));
      expect(await first.sync()).toContain(PANE);
      expect(await first.logs.loadCursor(PANE)).toEqual({ epoch: program.epoch, after: 2 });

      // The bridge restarts. The program goes on, and its tail still holds the cursor.
      program.appendEvent(PANE, item("i3", "three"));
      program.appendEvent(PANE, item("i4", "four"));
      const mark = program.requests.length;
      const second = bridge(program, folder);
      expect(await second.sync()).toContain(PANE);
      expect(eventReads(program, mark)).toEqual([`?after=2&epoch=${program.epoch}`]);
      expect(await loggedIds(folder)).toEqual(["i1", "i2", "i3", "i4"]);
      expect(await second.logs.loadCursor(PANE)).toEqual({ epoch: program.epoch, after: 4 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cursor: a saved cursor from an old epoch is read with that epoch, and the reset reply writes nothing twice", async () => {
    const program = await FakeDurableProgram.startWire();
    programs.push(program);
    const dir = await mkdtemp(join(tmpdir(), "collie-durable-cursor-"));
    try {
      const folder = join(dir, "durable");
      const first = bridge(program, folder);
      program.appendEvent(PANE, item("i1", "one"));
      await first.sync();
      const old = program.epoch;
      // The program restarts while the bridge is down: a new epoch, and its cursors start over.
      program.restart();
      program.appendEvent(PANE, item("i2", "two"));
      const mark = program.requests.length;
      const second = bridge(program, folder);
      await second.sync();
      expect(eventReads(program, mark)[0]).toBe(`?after=1&epoch=${old}`);
      expect(await loggedIds(folder)).toEqual(["i1", "i2"]);
      expect(await second.logs.loadCursor(PANE)).toEqual({ epoch: program.epoch, after: program.eventCount(PANE) });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cursor: a pane that leaves the layout forgets its saved cursor, so a reopen under the same id reads from 0", async () => {
    const program = await FakeDurableProgram.startWire();
    programs.push(program);
    const dir = await mkdtemp(join(tmpdir(), "collie-durable-cursor-"));
    try {
      const folder = join(dir, "durable");
      const one = bridge(program, folder);
      program.appendEvent(PANE, item("i1", "one"));
      await one.sync();
      expect(await one.logs.loadCursor(PANE)).not.toBeNull();
      program.removePane(PANE);
      await one.sync();
      expect(await one.logs.loadCursor(PANE)).toBeNull();
      // The log stays: it is the cache Chat reads.
      expect(await loggedIds(folder)).toEqual(["i1"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cursor: a pane's events go to the log of its sessionId, the key the journal reads", async () => {
    const program = await FakeDurableProgram.startWire();
    programs.push(program);
    program.snapshot.panes = program.snapshot.panes.map((pane) => (pane.id === PANE ? { ...pane, sessionId: "session-1" } : pane));
    const dir = await mkdtemp(join(tmpdir(), "collie-durable-cursor-"));
    try {
      const folder = join(dir, "durable");
      const one = bridge(program, folder);
      program.appendEvent(PANE, item("i1", "one"));
      await one.sync();
      const names = await readdir(folder);
      expect(names).toContain(logFileName("session-1"));
      expect(names).toContain(cursorFileName("session-1"));
      expect(names).not.toContain(logFileName(PANE));
      expect(one.adapter.program()?.snapshot.panes.find((pane) => pane.id === PANE)?.sessionId).toBe("session-1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("a user item that names a request id (M56 spec 14)", () => {
  test("the pane it belongs to is told, after the sink took the events; an item with no id tells nobody", async () => {
    const { program, adapter, sink, sync } = await rig();
    const heard: [string, string][] = [];
    const stop = adapter.onUserItem((paneId, requestId) => void heard.push([paneId, requestId]));
    program.appendEvent(PANE, { type: "item", item: { id: "u1", kind: "user", text: "hello", requestId: "req-0001" } });
    program.appendEvent(PANE, { type: "item", item: { id: "u2", kind: "user", text: "typed at the desk" } });
    program.appendEvent(PANE, item("r1", "a reply"));
    await sync();
    expect(sink.types(PANE)).toEqual(["item", "item", "item"]);
    expect(heard).toEqual([[PANE, "req-0001"]]);
    stop();
    program.appendEvent(PANE, { type: "item", item: { id: "u3", kind: "user", text: "again", requestId: "req-0002" } });
    await sync();
    expect(heard).toEqual([[PANE, "req-0001"]]);
  });

  test("a listener that throws never stops the log", async () => {
    const { program, adapter, sink, sync } = await rig();
    adapter.onUserItem(() => {
      throw new Error("boom");
    });
    program.appendEvent(PANE, { type: "item", item: { id: "u1", kind: "user", text: "hello", requestId: "req-0003" } });
    program.appendEvent(PANE, item("r1", "a reply"));
    await sync();
    expect(sink.types(PANE)).toEqual(["item", "item"]);
  });
});
