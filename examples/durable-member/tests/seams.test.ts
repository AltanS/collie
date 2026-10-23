// The seams a host with no process of its own uses (core/layout.ts, core/index.ts): a named epoch, an injected rev, a
// fixed turn id, a send that waits for idle, and asks seeded from a journal with a sink in place of a promise. The
// memory path is unchanged and is the protocol suite's business; this file is what only the seams promise.
import { describe, expect, test } from "bun:test";
import { api, type Dial } from "./client.ts";
import {
  type Answer,
  type Ask,
  type AskSink,
  createCore,
  foldJournal,
  type JournalRecord,
  type PaneHandle,
  type PaneOptions,
  type SeededAsk,
  type SinkReply,
  Store,
} from "../../../packages/durable-sdk/src/core/index.ts";

const options = [
  { id: "allow", label: "Allow", effect: "allow" as const },
  { id: "deny", label: "Deny", effect: "deny" as const },
];
const askOf = (id: string, over: Partial<Ask> = {}): Ask => ({ id, kind: "permission", toolCallId: `call-${id}`, revision: 1, title: `${id} wants to run`, itemId: `call-${id}`, options, ...over });
const seed = (id: string, over: Partial<SeededAsk> = {}): SeededAsk => ({ askId: id, toolCallId: `call-${id}`, argsHash: "h", ask: askOf(id), openedAt: "2026-10-21T10:00:00.000Z", ...over });

/** A sink that records its calls and answers with what the test says. */
function sinkOf(reply: SinkReply | (() => SinkReply | Promise<SinkReply>)) {
  const calls: [string, number, Answer, string][] = [];
  const sink: AskSink = {
    answer: async (askId, revision, answer, requestId) => {
      calls.push([askId, revision, answer, requestId]);
      return typeof reply === "function" ? reply() : reply;
    },
  };
  return { sink, calls };
}

/** A core with one pane on a named epoch, ready, and the dial that reaches it. */
function open(o: { paneOptions?: PaneOptions } = {}, core = createCore({ hostName: "seams", epoch: "epoch-1" })) {
  const pane: PaneHandle = core.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("p", { title: "P", harness: "x", ...o.paneOptions });
  core.ready();
  const d: Dial = { handler: (r) => core.handle(r), version: 1 };
  return { core, pane, d };
}

describe("epoch and rev", () => {
  test("a named epoch is the core's epoch, hello's and the snapshot's, on every core made with it", async () => {
    const a = open();
    const b = open({}, createCore({ hostName: "seams", epoch: "epoch-1" }));
    expect(a.core.epoch).toBe("epoch-1");
    expect((await api.hello(a.d)).body.epoch).toBe("epoch-1");
    expect((await api.snapshot(b.d)).body.epoch).toBe("epoch-1");
    expect((await api.events(a.d, "p", 0)).body.epoch).toBe("epoch-1");
  });

  test("an epoch that breaks the id rule is refused when the core is made", () => {
    for (const bad of ["", "a b", "a/b", "x".repeat(129)]) expect(() => createCore({ hostName: "e", epoch: bad })).toThrow(TypeError);
  });

  test("left out, the epoch is 128 random bits, new for every core", () => {
    const [a, b] = [createCore({ hostName: "e" }), createCore({ hostName: "e" })];
    expect(a.epoch).toMatch(/^[0-9a-f]{32}$/);
    expect(a.epoch).not.toBe(b.epoch);
  });

  test("an injected rev is the snapshot's rev and its ETag, read at every snapshot; the counter still runs", async () => {
    let rev = 41;
    const { d, pane } = open({}, createCore({ hostName: "r", epoch: "e", rev: () => rev }));
    const first = await api.snapshot(d);
    expect([first.body.rev, first.etag]).toEqual([41, '"e-41"']);
    pane.subtitle("moved"); // the counter moves, the injected rev does not
    expect((await api.snapshot(d, first.etag)).status).toBe(304);
    rev = 42;
    const second = await api.snapshot(d, first.etag);
    expect([second.status, second.body.rev]).toEqual([200, 42]);
  });

  test("a rev that is not a whole number from 1 is a RangeError at the snapshot", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => new Store(500, undefined, true, { rev: () => bad }).snapshot()).toThrow(RangeError);
  });
});

describe("turn id and send", () => {
  test("a fixed turn id stays through state changes; without one the pane mints a new id when a turn starts", async () => {
    const fixed = open({ paneOptions: { turnId: "turn-7" } });
    const minted = open();
    const turnOf = async (d: Dial) => (await api.snapshot(d)).body.panes[0]!.turnId;
    const before = await turnOf(minted.d);
    for (const p of [fixed.pane, minted.pane]) {
      p.state("working");
      p.state("idle");
      p.state("working");
    }
    expect(await turnOf(fixed.d)).toBe("turn-7");
    expect(await turnOf(minted.d)).not.toBe(before);
  });

  test("a turn id that breaks the id rule is refused", () => {
    expect(() => open({ paneOptions: { turnId: "a b" } })).toThrow(TypeError);
  });

  test("sendWhenIdleOnly: a send is taken when the pane is idle, and 409 not-supported while it works or waits", async () => {
    const sent: string[] = [];
    const { d, pane } = open({ paneOptions: { turnId: "turn-1", sendWhenIdleOnly: true } });
    pane.onSend((text) => void sent.push(text));
    expect((await api.send(d, "p", "one")).status).toBe(200);
    pane.state("working");
    const working = await api.send(d, "p", "two");
    expect([working.status, working.body.code]).toEqual([409, "not-supported"]);
    pane.state("idle");
    pane.seedAsk(seed("a"), sinkOf({ taken: true }).sink); // waiting is a turn that runs
    const waiting = await api.send(d, "p", "three");
    expect([waiting.status, waiting.body.code]).toEqual([409, "not-supported"]);
    expect(sent).toEqual(["one"]);
  });

  test("without the option a pane takes a send while it works, as it always did", async () => {
    const { d, pane } = open();
    pane.onSend(() => {});
    pane.state("working");
    expect((await api.send(d, "p", "steer")).status).toBe(200);
  });
});

describe("a seeded ask", () => {
  test("it shows as an open ask: the pane waits, the snapshot lists it, a reset read carries it", async () => {
    const { d, pane } = open();
    pane.seedAsk(seed("a", { expiresAt: "2999-01-01T00:00:00.000Z" }), sinkOf({ taken: true }).sink);
    const info = (await api.snapshot(d)).body.panes[0]!;
    expect(info.state).toBe("waiting");
    expect(info.openAsks.map((a) => [a.id, a.revision, a.expiresAt])).toEqual([["a", 1, "2999-01-01T00:00:00.000Z"]]);
    expect(pane.openAsks[0]!.title).toBe("a wants to run");
    const events = (await api.events(d, "p", 0, "stale")).body.events!;
    expect(events.map((e) => e.type)).toEqual(["reset", "ask", "state", "synced"]);
  });

  test("an answer goes to the sink with the ask id, the open revision and the request id; taken closes the ask as the phone's", async () => {
    const { d, pane } = open();
    const { sink, calls } = sinkOf({ taken: true, at: "2026-10-21T10:01:00.000Z" });
    pane.seedAsk(seed("a"), sink);
    const r = await api.answer(d, "p", "a", "allow", { requestId: "req-1" });
    expect([r.status, r.body]).toEqual([200, { result: "taken" }]);
    expect(calls).toEqual([["a", 1, { optionId: "allow" }, "req-1"]]);
    expect(pane.outcomeOf("a")).toEqual({ decidedBy: "phone", decidedAt: "2026-10-21T10:01:00.000Z", optionId: "allow", effect: "allow" });
    const info = (await api.snapshot(d)).body.panes[0]!;
    expect([info.state, info.openAsks]).toEqual(["idle", []]);
  });

  test("the sink is asked once for one request id: a repeat is the first reply with replayed", async () => {
    const { d, pane } = open();
    const { sink, calls } = sinkOf({ taken: true });
    pane.seedAsk(seed("a"), sink);
    await api.answer(d, "p", "a", "allow", { requestId: "req-1" });
    const again = await api.answer(d, "p", "a", "allow", { requestId: "req-1" });
    expect(again.body).toEqual({ result: "taken", replayed: true });
    expect(calls).toHaveLength(1);
  });

  test("a sink that says another answer won gives 409 decided with the first outcome, and the ask is closed here too", async () => {
    const { d, pane } = open();
    const first = { decidedBy: "phone" as const, decidedAt: "2026-10-21T10:00:30.000Z", optionId: "deny", effect: "deny" as const };
    const { sink, calls } = sinkOf({ taken: false, decided: first });
    pane.seedAsk(seed("a"), sink);
    const r = await api.answer(d, "p", "a", "allow");
    expect([r.status, r.body.code, r.body.outcome]).toEqual([409, "decided", first]);
    expect((await api.snapshot(d)).body.panes[0]!.openAsks).toEqual([]);
    const second = await api.answer(d, "p", "a", "allow"); // answered from the pane's own memory now: the sink is not asked again
    expect([second.status, second.body.outcome]).toEqual([409, first]);
    expect(calls).toHaveLength(1);
  });

  test("a sink that does not know the ask gives too-late and the ask stays open", async () => {
    const { d, pane } = open();
    pane.seedAsk(seed("a"), sinkOf({ taken: false, tooLate: true }).sink);
    const r = await api.answer(d, "p", "a", "allow");
    expect([r.status, r.body]).toEqual([200, { result: "too-late" }]);
    expect(pane.openAsks.map((a) => a.id)).toEqual(["a"]);
  });

  test("the pane checks the answer before the sink: a stale revision and an unknown option never reach it", async () => {
    const { d, pane } = open();
    const { sink, calls } = sinkOf({ taken: true });
    pane.seedAsk(seed("a"), sink);
    const stale = await api.answer(d, "p", "a", "allow", { revision: 9 });
    expect([stale.status, stale.body.code]).toEqual([409, "stale"]);
    const bad = await api.answer(d, "p", "a", "nope");
    expect([bad.status, bad.body.code]).toEqual([400, "bad-option"]);
    expect(calls).toEqual([]);
  });

  test("a sink that throws is a 500, the ask stays open, and the request id may run again", async () => {
    const { d, pane } = open();
    let fail = true;
    const { sink, calls } = sinkOf(() => {
      if (fail) throw new Error("world down");
      return { taken: true };
    });
    pane.seedAsk(seed("a"), sink);
    const original = console.error;
    console.error = () => {};
    try {
      const r = await api.answer(d, "p", "a", "allow", { requestId: "req-1" });
      expect([r.status, r.body.code]).toEqual([500, "internal"]);
    } finally {
      console.error = original;
    }
    expect(pane.openAsks).toHaveLength(1);
    fail = false;
    expect((await api.answer(d, "p", "a", "allow", { requestId: "req-1" })).body).toEqual({ result: "taken" });
    expect(calls).toHaveLength(2);
  });

  test("an ask past its expiresAt reads as decided by timeout at exactly expiresAt, on every read", async () => {
    const a = open();
    const b = open();
    const expiresAt = "2026-10-21T10:05:00.000Z";
    for (const { pane } of [a, b]) pane.seedAsk(seed("a", { expiresAt }), sinkOf({ taken: true }).sink);
    expect((await api.snapshot(a.d)).body.panes[0]!.openAsks).toEqual([]);
    await Bun.sleep(5);
    expect((await api.snapshot(b.d)).body.panes[0]!.openAsks).toEqual([]);
    const late = await api.answer(a.d, "p", "a", "allow");
    expect([late.status, late.body.code, late.body.outcome]).toEqual([409, "decided", { decidedBy: "timeout", decidedAt: expiresAt }]);
    expect(b.pane.outcomeOf("a")).toEqual({ decidedBy: "timeout", decidedAt: expiresAt });
  });

  test("a record the core would not accept is a TypeError: an id mismatch, an id already open, a bad option effect, allow-always over TLS", () => {
    const { pane } = open();
    const { sink } = sinkOf({ taken: true });
    expect(() => pane.seedAsk(seed("a", { askId: "b" }), sink)).toThrow(TypeError);
    pane.seedAsk(seed("a"), sink);
    expect(() => pane.seedAsk(seed("a"), sink)).toThrow("already open");
    expect(() => pane.seedAsk(seed("c", { ask: askOf("c", { options: [{ id: "x", label: "X", effect: "bogus" as never }] }) }), sink)).toThrow(TypeError);
    const tls = open({}, createCore({ hostName: "t", allowAlways: false })).pane;
    const always = askOf("d", { options: [{ id: "always", label: "Always", effect: "allow-always" }] });
    expect(() => tls.seedAsk(seed("d", { ask: always }), sink)).toThrow("WIRE.md 1B");
  });

  test("seeding writes nothing a reader polls on: lastActiveAt stays, and the injected rev is all the snapshot reports", async () => {
    let rev = 5;
    const { d, pane } = open({}, createCore({ hostName: "s", epoch: "e", rev: () => rev }));
    const before = (await api.snapshot(d)).body.panes[0]!.lastActiveAt;
    await Bun.sleep(5);
    pane.seedAsk(seed("a"), sinkOf({ taken: true }).sink);
    const after = await api.snapshot(d);
    expect([after.body.panes[0]!.lastActiveAt, after.body.rev]).toEqual([before, 5]);
  });
});

describe("a seeded decided map", () => {
  test("an answer to a decided ask is 409 decided with the first outcome; an unknown id is too-late", async () => {
    const { d, pane } = open();
    const outcome = { decidedBy: "phone" as const, decidedAt: "2026-10-21T10:01:00.000Z", optionId: "allow", effect: "allow" as const };
    pane.seedDecided(new Map([["done", outcome]]));
    const r = await api.answer(d, "p", "done", "deny");
    expect([r.status, r.body.code, r.body.outcome]).toEqual([409, "decided", outcome]);
    expect((await api.answer(d, "p", "never", "deny")).body).toEqual({ result: "too-late" });
  });

  test("it keeps the newest 500 outcomes, in the order given, and copies only the fields of an outcome", () => {
    const { pane } = open();
    const all = new Map<string, { decidedBy: "program"; decidedAt: string }>();
    for (let i = 0; i < 505; i++) all.set(`ask-${i}`, { decidedBy: "program", decidedAt: "2026-10-21T10:00:00.000Z", extra: "x" } as never);
    pane.seedDecided(all);
    expect([pane.outcomeOf("ask-4"), pane.outcomeOf("ask-5")]).toEqual([undefined, { decidedBy: "program", decidedAt: "2026-10-21T10:00:00.000Z" }]);
  });
});

describe("a fold seeds a pane", () => {
  test("the open asks of a journal open, its decided asks answer 409, and an answer lands through the sink", async () => {
    const records: JournalRecord[] = [
      { t: "ask", askId: "a", toolCallId: "call-a", argsHash: "h", ask: askOf("a"), openedAt: "2026-10-21T10:00:00.000Z" },
      { t: "ask", askId: "b", toolCallId: "call-b", argsHash: "h", ask: askOf("b"), openedAt: "2026-10-21T10:00:01.000Z" },
      { t: "answer", askId: "a", revision: 1, answer: { optionId: "deny" }, requestId: "r0", nonce: "n0", at: "2026-10-21T10:00:30.000Z" },
    ];
    const folded = foldJournal(records);
    const { d, pane } = open();
    const { sink, calls } = sinkOf({ taken: true });
    pane.seedDecided(folded.decided);
    for (const record of folded.open) pane.seedAsk(record, sink);
    expect(pane.openAsks.map((a) => a.id)).toEqual(["b"]);
    expect((await api.answer(d, "p", "a", "allow")).body.outcome).toEqual({ decidedBy: "phone", decidedAt: "2026-10-21T10:00:30.000Z", optionId: "deny", effect: "deny" });
    expect((await api.answer(d, "p", "b", "allow")).body).toEqual({ result: "taken" });
    expect(calls.map((c) => c[0])).toEqual(["b"]);
  });
});
