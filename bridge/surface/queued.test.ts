// QueuedSends alone (ADR 0122): the cap and the memory bound, with a fake store and a fixed matcher.
// The protocol-level cases (a real OMP fake pane, the routes, the Stop) are in protocol.test.ts.

import { describe, expect, test } from "bun:test";
import { IDLE_EMPTY_POLLS, QUEUED_SEND_MS, QUEUED_SENDS_MAX, QueuedSends } from "./queued.ts";

function memory() {
  const clock = { now: 1_000_000 };
  const marked: string[] = [];
  const sends = new QueuedSends({
    store: { list: () => [], markReturned: (id) => (marked.push(id), true) },
    generation: () => "omp:session",
    matches: (box, lines) => box.replace(/\s+/gu, " ").trim() === lines.join(" ").replace(/\s+/gu, " ").trim(),
    now: () => clock.now,
    busy: () => false,
  });
  const add = (id: string, text: string, steer = false): void => sends.add({ id, session: "main", paneId: "%1", generation: "omp:session", text, collapse: null, at: clock.now, steer });
  return { clock, marked, sends, add };
}

describe("QueuedSends", () => {
  test("past the cap the oldest cards turn unconfirmed rather than vanish", () => {
    const m = memory();
    for (let i = 0; i <= QUEUED_SENDS_MAX; i++) {
      m.add(`queued-cap-${String(i).padStart(4, "0")}`, `message ${String(i)}`);
      m.clock.now += 10;
    }
    const cards = m.sends.of("main", "%1");
    expect(cards).toHaveLength(QUEUED_SENDS_MAX + 1);
    expect(cards[0]).toMatchObject({ requestId: "queued-cap-0000", state: "unconfirmed" });
    expect(cards.filter((card) => card.state === "queued")).toHaveLength(QUEUED_SENDS_MAX);
  });

  test("memory has an end: unconfirmed cards past twice the cap go, oldest first", () => {
    const m = memory();
    for (let i = 0; i < 3 * QUEUED_SENDS_MAX; i++) {
      m.add(`queued-mem-${String(i).padStart(4, "0")}`, `message ${String(i)}`);
      m.clock.now += 10;
    }
    const cards = m.sends.of("main", "%1");
    expect(cards).toHaveLength(2 * QUEUED_SENDS_MAX);
    expect(cards[0]?.requestId).toBe(`queued-mem-${String(QUEUED_SENDS_MAX).padStart(4, "0")}`);
  });

  test("a returned card keeps its clock from the last read that saw it in the box", () => {
    const m = memory();
    m.add("queued-ret-0001", "second message");
    m.clock.now += 1_000;
    expect(m.sends.boxRead("main", "%1", { box: "second message", at: m.clock.now, turn: "idle", poll: true })).toEqual(["queued-ret-0001"]);
    expect(m.marked).toEqual(["queued-ret-0001"]);
    m.clock.now += QUEUED_SEND_MS - 1;
    m.sends.boxRead("main", "%1", { box: "second message", at: m.clock.now, turn: "idle", poll: true });
    m.clock.now += QUEUED_SEND_MS;
    expect(m.sends.of("main", "%1")).toMatchObject([{ state: "returned" }]);
    m.clock.now += 1;
    expect(m.sends.of("main", "%1")).toMatchObject([{ state: "unconfirmed" }]);
  });

  test("an idle, empty box ends a returned card (the text left the box); it never turns it unconfirmed", () => {
    const m = memory();
    m.add("queued-ret-0002", "second message");
    m.clock.now += 1_000;
    m.sends.boxRead("main", "%1", { box: "second message", at: m.clock.now, turn: "idle", poll: true });
    for (let i = 0; i < IDLE_EMPTY_POLLS; i++) {
      m.clock.now += 1_000;
      m.sends.boxRead("main", "%1", { box: "", at: m.clock.now, turn: "idle", poll: true });
    }
    expect(m.sends.of("main", "%1")).toEqual([]);
  });

  test("a steer is no card until the box gives it back, and the run is steers first", () => {
    const m = memory();
    m.add("queued-st-0001", "Q text");
    m.clock.now += 100;
    m.add("queued-st-0002", "S text", true);
    expect(m.sends.of("main", "%1")).toMatchObject([{ requestId: "queued-st-0001", state: "queued" }]);
    m.clock.now += 1_000;
    expect(m.sends.boxRead("main", "%1", { box: "S text\n\nQ text", at: m.clock.now, turn: "idle", poll: false })).toEqual(["queued-st-0002", "queued-st-0001"]);
    expect(m.marked).toEqual(["queued-st-0002", "queued-st-0001"]);
    expect(m.sends.of("main", "%1")).toMatchObject([{ requestId: "queued-st-0002", text: "S text\nQ text", state: "returned" }]);
  });

  test("a steer the box never gave back is dropped without a card: idle polls, or the bound", () => {
    const m = memory();
    m.add("queued-st-0003", "S text", true);
    // Running reads start the count again; a Stop's read-back is no poll.
    m.clock.now += 1_000;
    m.sends.boxRead("main", "%1", { box: "", at: m.clock.now, turn: "idle", poll: true });
    m.clock.now += 1_000;
    m.sends.boxRead("main", "%1", { box: "", at: m.clock.now, turn: "running", poll: true });
    for (let i = 0; i < IDLE_EMPTY_POLLS; i++) {
      m.clock.now += 1_000;
      m.sends.boxRead("main", "%1", { box: "elsewhere", at: m.clock.now, turn: "idle", poll: true });
    }
    expect(m.sends.panes("main")).toEqual([]);
    m.clock.now += 1_000;
    expect(m.sends.boxRead("main", "%1", { box: "S text", at: m.clock.now, turn: "idle", poll: true })).toEqual([]);
    expect(m.marked).toEqual([]);
    // The bound: never an unconfirmed card for a steer nobody saw in the box.
    m.add("queued-st-0004", "T text", true);
    m.clock.now += QUEUED_SEND_MS + 1;
    expect(m.sends.of("main", "%1")).toEqual([]);
    expect(m.sends.panes("main")).toEqual([]);
  });

  test("a door's send is never taken back from the box: a desk draft with its text is not the send come back", () => {
    const m = memory();
    m.sends.add({ id: "queued-door-001", session: "main", paneId: "%1", generation: "omp:session", text: "fix the tests", collapse: null, at: m.clock.now, door: true });
    m.clock.now += 1_000;
    expect(m.sends.boxRead("main", "%1", { box: "fix the tests", at: m.clock.now, turn: "idle", poll: true })).toEqual([]);
    expect(m.marked).toEqual([]);
    expect(m.sends.of("main", "%1")).toEqual([{ requestId: "queued-door-001", text: "fix the tests", at: m.clock.now - 1_000, state: "queued", door: true }]);
  });

  test("the journal's proof: landed ends a door's card, merged marks it, and Discard takes a merged card", () => {
    const m = memory();
    const door = (id: string): void => m.sends.add({ id, session: "main", paneId: "%1", generation: "omp:session", text: id, collapse: null, at: m.clock.now, door: true });
    door("queued-door-002");
    door("queued-door-003");
    m.add("queued-scr-0001", "typed");
    expect(m.sends.proved("main", "%1", "queued-door-002", "landed")).toBe(true);
    expect(m.sends.proved("main", "%1", "queued-door-003", "merged")).toBe(true);
    expect(m.sends.proved("main", "%1", "queued-scr-0001", "landed")).toBe(false);
    expect(m.sends.proved("main", "%2", "queued-door-003", "landed")).toBe(false);
    expect(m.sends.of("main", "%1").map((card) => [card.requestId, card.merged ?? false])).toEqual([
      ["queued-door-003", true],
      ["queued-scr-0001", false],
    ]);
    expect(m.sends.dismissUnconfirmed("main", "%1", "queued-door-003")).toBe(true);
    expect(m.sends.dismissUnconfirmed("main", "%1", "queued-scr-0001")).toBe(false);
  });
  test("a door's send turns returned only on the journal's word after the agent's, and no box read ends it (SPEC V26)", () => {
    const m = memory();
    const door = (id: string): void => m.sends.add({ id, session: "main", paneId: "%1", generation: "omp:session", text: id, collapse: null, at: m.clock.now, door: true });
    door("queued-door-004");
    door("queued-door-005");
    expect(m.sends.doorWaiting("main")).toEqual([{ paneId: "%1", agent: "omp" }]);
    // No word from the agent yet: the journal cannot return it.
    expect(m.sends.proved("main", "%1", "queued-door-004", "returned")).toBe(false);
    m.clock.now += 1_000;
    m.sends.doorLeft("main", "%1", ["queued-door-004", "not-mine-000"], m.clock.now);
    m.sends.doorLeft("main", "%1", ["queued-door-004"], m.clock.now + 5);
    expect(m.sends.of("main", "%1").map((card) => [card.requestId, card.leftAt])).toEqual([
      ["queued-door-004", m.clock.now],
      ["queued-door-005", undefined],
    ]);
    expect(m.sends.doorWaiting("main")).toEqual([{ paneId: "%1", agent: "omp" }]);
    expect(m.sends.proved("main", "%1", "queued-door-004", "returned")).toBe(true);
    expect(m.sends.proved("main", "%1", "queued-door-004", "returned")).toBe(false);
    // Box reads, an empty one and one that holds another draft, leave the door's returned card alone.
    m.clock.now += 1_000;
    m.sends.boxRead("main", "%1", { box: "", at: m.clock.now, turn: "idle", poll: true });
    m.sends.boxRead("main", "%1", { box: "something else", at: m.clock.now + 1, turn: "idle", poll: true });
    expect(m.sends.returnedText("main", "%1", "queued-door-004")).toBe("queued-door-004");
    expect(m.sends.of("main", "%1").find((card) => card.requestId === "queued-door-004")?.state).toBe("returned");
    // The bound still ends it, from when it turned returned.
    m.clock.now += QUEUED_SEND_MS + 1;
    expect(m.sends.of("main", "%1").find((card) => card.requestId === "queued-door-004")?.state).toBe("unconfirmed");
  });
});
