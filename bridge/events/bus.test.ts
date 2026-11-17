import { describe, expect, test } from "bun:test";

import { DEFAULT_QUEUE, DEFAULT_RING_AGE_MS, DEFAULT_RING_COUNT, EventBus, type EventBusOptions, type PublishInput, type SessionState } from "./bus.ts";

function makeBus(opts: Partial<EventBusOptions> = {}) {
  const clock = { t: Date.UTC(2026, 10, 17, 12, 0, 0) };
  const bus = new EventBus({ machine: () => "m_k3x9q2w7ab", bootId: "boot1", now: () => clock.t, ...opts });
  return { bus, clock };
}

const status = (session: string, state: SessionState): PublishInput => ({ type: "session.status", session, data: { state } });
const turnEnd = (session: string): PublishInput => ({ type: "turn.end", session });

describe("the event", () => {
  test("carries the contract's fields and nothing else", () => {
    const { bus } = makeBus();
    const event = bus.publish(status("ses_a", "working"));
    expect(event).toEqual({ v: 1, id: "evt_boot1.1", cursor: "boot1.1", ts: "2026-11-17T12:00:00.000Z", type: "session.status", machine: "m_k3x9q2w7ab", session: "ses_a", data: { state: "working" } });
  });

  test("an extra field a caller slips in never reaches the event (no text, decision 4)", () => {
    const { bus } = makeBus();
    // Not literals at the call, so the compiler's excess-property check does not stop them: the bus must.
    const state: SessionState = "blocked";
    const sneaky = { type: "session.status" as const, session: "ses_a", data: { state, question: "Delete prod?" }, title: "secret" };
    const event = bus.publish(sneaky);
    expect(JSON.stringify(event)).not.toContain("Delete");
    expect(JSON.stringify(event)).not.toContain("secret");
    const withText = { type: "turn.end" as const, session: "ses_a", data: { text: "hi" } };
    const end = bus.publish(withText);
    expect(end.data).toEqual({});
  });

  test("a session or a machine that is not an id is refused, and so is an unknown state", () => {
    const { bus } = makeBus();
    expect(() => bus.publish(status("a path/with space", "idle"))).toThrow();
    // SAFETY: a state outside the type on purpose; the assertion is the input this test proves publish refuses.
    const thinking = "thinking" as SessionState;
    expect(() => bus.publish(status("ses_a", thinking))).toThrow();
    const bad = makeBus({ machine: () => "my laptop" }).bus;
    expect(() => bad.publish(status("ses_a", "idle"))).toThrow();
  });

  test("the defaults are the spec's numbers", () => {
    expect(DEFAULT_RING_COUNT).toBe(2048);
    expect(DEFAULT_RING_AGE_MS).toBe(3_600_000);
    expect(DEFAULT_QUEUE).toBe(256);
  });
});

describe("since", () => {
  test("no cursor answers no events and the head: a new reader starts at now", () => {
    const { bus } = makeBus();
    bus.publish(status("ses_a", "working"));
    bus.publish(status("ses_a", "idle"));
    expect(bus.since(undefined)).toEqual({ events: [], next: "boot1.2" });
  });

  test("a cursor inside the buffer answers the events after it", () => {
    const { bus } = makeBus();
    const head = bus.since(undefined).next;
    bus.publish(status("ses_a", "working"));
    bus.publish(turnEnd("ses_a"));
    const answer = bus.since(head);
    expect(answer.events.map((e) => e.cursor)).toEqual(["boot1.1", "boot1.2"]);
    expect(answer.next).toBe("boot1.2");
    expect(bus.since(answer.next).events).toEqual([]);
  });

  test("a cursor evicted by count gets ONE gap, then every buffered event", () => {
    const { bus } = makeBus({ maxCount: 3 });
    const head = bus.since(undefined).next;
    for (let i = 0; i < 5; i++) bus.publish(status(`ses_${String(i)}`, "working"));
    const answer = bus.since(head);
    expect(answer.events.map((e) => e.type)).toEqual(["gap", "session.status", "session.status", "session.status"]);
    expect(answer.events[0]!.data).toEqual({ reason: "evicted" });
    expect(answer.events[0]!.session).toBeNull();
    expect(answer.events.slice(1).map((e) => e.cursor)).toEqual(["boot1.3", "boot1.4", "boot1.5"]);
    // The marker's cursor resumes just before the oldest buffered event: no second gap.
    expect(bus.since(answer.events[0]!.cursor).events.map((e) => e.type)).toEqual(["session.status", "session.status", "session.status"]);
  });

  test("the cursor right before the oldest buffered event is no gap", () => {
    const { bus } = makeBus({ maxCount: 2 });
    for (let i = 0; i < 4; i++) bus.publish(status("ses_a", "working"));
    expect(bus.since("boot1.2").events.map((e) => e.cursor)).toEqual(["boot1.3", "boot1.4"]);
    expect(bus.since("boot1.1").events[0]!.type).toBe("gap");
  });

  test("a cursor evicted by age gets ONE gap, also when the buffer is now empty", () => {
    const { bus, clock } = makeBus({ maxAgeMs: 1000 });
    const head = bus.since(undefined).next;
    bus.publish(status("ses_a", "working"));
    clock.t += 600;
    bus.publish(status("ses_a", "idle"));
    clock.t += 600;
    const answer = bus.since(head);
    expect(answer.events.map((e) => e.type)).toEqual(["gap", "session.status"]);
    expect(answer.events[1]!.cursor).toBe("boot1.2");
    clock.t += 2000;
    const empty = bus.since(head);
    expect(empty.events.map((e) => e.type)).toEqual(["gap"]);
    expect(empty.next).toBe("boot1.2");
    // The head itself is no gap: nothing was lost after it.
    expect(bus.since("boot1.2").events).toEqual([]);
  });

  test("a cursor of another boot gets ONE reset, then every buffered event", () => {
    const { bus } = makeBus();
    bus.publish(status("ses_a", "working"));
    const answer = bus.since("oldboot.7");
    expect(answer.events.map((e) => e.type)).toEqual(["reset", "session.status"]);
    expect(answer.events[0]!.data).toEqual({ reason: "other-boot" });
  });

  test("a cursor of this boot past the head is a reset, never a silent hole", () => {
    const { bus } = makeBus();
    bus.publish(status("ses_a", "working"));
    expect(bus.since("boot1.99").events.map((e) => e.type)).toEqual(["reset", "session.status"]);
  });

  test.each(["", "garbage", "boot1.", "boot1.01", "BOOT1.1", "boot1.1.1", "boot1.-1", "a".repeat(40)])("garbage %p gets ONE reset", (cursor) => {
    const { bus } = makeBus();
    bus.publish(status("ses_a", "working"));
    const answer = bus.since(cursor);
    expect(answer.events.map((e) => e.type)).toEqual(["reset", "session.status"]);
    expect(answer.events[0]!.data).toEqual({ reason: "unreadable" });
  });

  test("markers have ids of their own", () => {
    const { bus } = makeBus();
    const a = bus.since("x").events[0]!;
    const b = bus.since("x").events[0]!;
    expect(a.id).not.toBe(b.id);
  });

  test("a new bus gets a new boot id by default", () => {
    const one = new EventBus({ machine: () => "m" });
    const two = new EventBus({ machine: () => "m" });
    expect(one.bootId).toMatch(/^[a-z0-9]{1,32}$/u);
    expect(one.bootId).not.toBe(two.bootId);
  });
});

describe("waitFor", () => {
  test("wakes on a publish and leaves nothing behind", async () => {
    const { bus } = makeBus();
    const waiting = bus.waitFor(bus.head(), 5000);
    expect(bus.listeners().waits).toBe(1);
    bus.publish(status("ses_a", "working"));
    expect(await waiting).toBe("event");
    expect(bus.listeners().waits).toBe(0);
  });

  test("answers at once when there is something to read already", async () => {
    const { bus } = makeBus();
    const head = bus.head();
    bus.publish(status("ses_a", "working"));
    expect(await bus.waitFor(head, 5000)).toBe("event");
    expect(await bus.waitFor("other.1", 5000)).toBe("event");
    expect(bus.listeners().waits).toBe(0);
  });

  test("ends on abort", async () => {
    const { bus } = makeBus();
    const controller = new AbortController();
    const waiting = bus.waitFor(bus.head(), 5000, controller.signal);
    controller.abort();
    expect(await waiting).toBe("aborted");
    expect(bus.listeners().waits).toBe(0);
    expect(await bus.waitFor(bus.head(), 5000, controller.signal)).toBe("aborted");
  });

  test("ends on its timeout", async () => {
    const { bus } = makeBus();
    expect(await bus.waitFor(bus.head(), 5)).toBe("timeout");
    expect(bus.listeners().waits).toBe(0);
  });
});

describe("subscribe", () => {
  test("session.status is coalesced per session: the old one goes, the newest is appended", () => {
    const { bus } = makeBus();
    const sub = bus.subscribe();
    bus.publish(status("ses_a", "working"));
    bus.publish(status("ses_b", "working"));
    bus.publish(turnEnd("ses_a"));
    bus.publish(status("ses_a", "idle"));
    const batch = sub.take();
    expect(batch.dropped).toBe(0);
    expect(batch.events.map((e) => `${e.type}:${e.session}:${e.type === "session.status" ? e.data.state : ""}`)).toEqual([
      "session.status:ses_b:working",
      "turn.end:ses_a:",
      "session.status:ses_a:idle",
    ]);
    expect(sub.take()).toEqual({ events: [], dropped: 0 });
  });

  test("coalescing frees a place: a full queue of one session's states drops nothing", () => {
    const { bus } = makeBus();
    const sub = bus.subscribe({ capacity: 2 });
    for (let i = 0; i < 50; i++) bus.publish(status("ses_a", i % 2 === 0 ? "working" : "idle"));
    expect(sub.take()).toMatchObject({ dropped: 0, events: [{ type: "session.status", data: { state: "idle" } }] });
  });

  test("on overflow the oldest non-status event goes and the next batch says how many", () => {
    const { bus } = makeBus();
    const sub = bus.subscribe({ capacity: 3 });
    bus.publish(status("ses_a", "working"));
    bus.publish(turnEnd("ses_1"));
    bus.publish(turnEnd("ses_2"));
    bus.publish(turnEnd("ses_3"));
    bus.publish(turnEnd("ses_4"));
    const batch = sub.take();
    expect(batch.dropped).toBe(2);
    expect(batch.events.map((e) => e.session)).toEqual(["ses_a", "ses_3", "ses_4"]);
    expect(sub.take().dropped).toBe(0);
  });

  test("a queue of only states drops the oldest state when a new session arrives", () => {
    const { bus } = makeBus();
    const sub = bus.subscribe({ capacity: 2 });
    bus.publish(status("ses_a", "working"));
    bus.publish(status("ses_b", "working"));
    bus.publish(status("ses_c", "working"));
    const batch = sub.take();
    expect(batch.dropped).toBe(1);
    expect(batch.events.map((e) => e.session)).toEqual(["ses_b", "ses_c"]);
  });

  test("a listener that never reads never blocks a publish, and the buffer still serves pull readers", () => {
    const { bus } = makeBus();
    const sub = bus.subscribe({ capacity: 4 });
    const head = bus.head();
    for (let i = 0; i < 1000; i++) bus.publish(turnEnd(`ses_${String(i)}`));
    expect(bus.since(head).events).toHaveLength(1000);
    const batch = sub.take();
    expect(batch.events).toHaveLength(4);
    expect(batch.dropped).toBe(996);
  });

  test("onReady is a notice once per empty-to-full edge, and one that throws breaks nothing", () => {
    const { bus } = makeBus();
    let calls = 0;
    const thrower = bus.subscribe({
      onReady: () => {
        calls += 1;
        throw new Error("listener bug");
      },
    });
    const other = bus.subscribe();
    expect(() => bus.publish(turnEnd("ses_a"))).not.toThrow();
    bus.publish(turnEnd("ses_b"));
    expect(calls).toBe(1);
    expect(other.take().events).toHaveLength(2);
    expect(thrower.take().events).toHaveLength(2);
    bus.publish(turnEnd("ses_c"));
    expect(calls).toBe(2);
  });

  test("unsubscribe frees the queue and stops delivery", () => {
    const { bus } = makeBus();
    const sub = bus.subscribe();
    bus.publish(turnEnd("ses_a"));
    sub.unsubscribe();
    expect(bus.listeners().subscriptions).toBe(0);
    bus.publish(turnEnd("ses_b"));
    expect(sub.take()).toEqual({ events: [], dropped: 0 });
    sub.unsubscribe();
    expect(bus.listeners().subscriptions).toBe(0);
  });

  test("an event handed to listeners is frozen, so one listener cannot change another's", () => {
    const { bus } = makeBus();
    const sub = bus.subscribe();
    bus.publish(status("ses_a", "working"));
    const [event] = sub.take().events;
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event!.data)).toBe(true);
  });
});
