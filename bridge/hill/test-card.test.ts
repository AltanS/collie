import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { AuditEntry } from "../audit.ts";
import { loadConfig } from "../config.ts";
import type { PushMessage } from "../push.ts";
import { LOOKING_MS } from "../push.ts";
import { guard, hillTestRoute } from "../server.ts";
import type { JsonValue } from "../json.ts";
import { HILL_COLLIE_REF_TYPES, HILL_OFF_TRICK_CARDS, type HillDecision } from "../../web/src/lib/hill/wire.ts";
import { HILL_PUSH_RATE, HillPush, hillRingBlock, type HillRingBlock, type HillRingFacts } from "./push.ts";
import { readDecision } from "./parse.ts";
import { memoryHillReceipts } from "./receipts.ts";
import { HILL_OFF, HillService, NOT_ON_LEAD } from "./service.ts";
import { HillStore } from "./store.ts";
import {
  HILL_TEST_DELAY_MS,
  HILL_TEST_EXPIRY_MS,
  HILL_TEST_OK,
  HILL_TEST_OK_LABEL,
  HILL_TEST_REF_HASH,
  HILL_TEST_SUMMARY,
  HILL_TEST_TITLE,
  answerTest,
  testCard,
  testSender,
} from "./test-card.ts";

// THE TEST DECISION (test-card.ts): the card's fixed words, the delay and the one-at-a-time rule, the answer, the
// expiry, the Hill off, the order of the reasons no notification is sent, and the route's gates.

interface Rig {
  readonly hill: HillService;
  readonly store: HillStore;
  readonly pushes: PushMessage[];
  readonly audit: AuditEntry[];
  /** The delays asked of the timer, and the posts it still holds. */
  readonly timers: Array<{ ms: number; fn: () => void; live: boolean; unref: () => void }>;
  state: { on: boolean; mode: "solo" | "peer"; crew: "here" | "quiet" | "away"; devices: number; pref: boolean; snoozed: boolean; push: boolean };
  clock: number;
  /** Run the oldest live timer, as its delay ending. */
  fire(): void;
}

function rig(): Rig {
  let n = 0;
  const pushes: PushMessage[] = [];
  const audit: AuditEntry[] = [];
  const timers: Rig["timers"] = [];
  const state: Rig["state"] = { on: true, mode: "solo", crew: "here", devices: 1, pref: true, snoozed: false, push: true };
  const clock = { now: 1_000_000 };
  const store = new HillStore(null, () => clock.now);
  const gates = () => ({ push: state.push, pref: state.pref, snoozed: state.snoozed, member: state.mode === "peer" });
  const hill = new HillService({
    store,
    receipts: memoryHillReceipts(),
    place: () => null,
    send: async () => "typed",
    crewMode: () => state.mode,
    walkyOn: () => true,
    memberId: "m_aaaaaaaaaa",
    machine: "desk",
    now: () => clock.now,
    mintId: () => `dc_test${String((n += 1)).padStart(8, "0")}`,
    audit: (entry) => audit.push(entry),
    tap: async () => true,
    push: new HillPush({ ready: () => hillRingBlock(gates()) === null, send: (message) => pushes.push(message), now: () => clock.now }),
    ringFacts: () => ({ ...gates(), devices: state.devices }),
    crewState: { read: () => ({ state: state.crew, at: null, by: null, told: null }) },
    hillSwitch: { on: () => state.on, reading: () => (state.on ? "on" : "off") },
    onCollieAnswer: async (ref, intent) => (ref.type === "test" ? answerTest(intent) : { ok: false, reason: "no" }),
    timer: {
      set: (fn, ms) => {
        const timer = { ms, fn, live: true, unref: () => undefined };
        timers.push(timer);
        return timer;
      },
    },
  });
  const made: Rig = {
    hill,
    store,
    pushes,
    audit,
    timers,
    state,
    get clock() {
      return clock.now;
    },
    set clock(value: number) {
      clock.now = value;
    },
    fire() {
      const next = timers.find((timer) => timer.live);
      if (next === undefined) throw new Error("no timer waits");
      next.live = false;
      next.fn();
    },
  };
  return made;
}

const openTests = (r: Rig): HillDecision[] => r.store.all().filter((d) => d.from.ref?.type === "test" && d.state === "open");

describe("the card", () => {
  test("holds the fixed words, priority now, an expiry of ten minutes, a fresh request id and Collie's test sender", () => {
    const card = testCard(5000, null);
    expect(card).toMatchObject({
      title: "Does the Hill reach you?",
      summary: "You sent this test from Settings. Tap the answer to close it.",
      options: [{ intent: "ok", label: "It works" }],
      text: "none",
      priority: "now",
      expiresAt: 5000 + 10 * 60_000,
    });
    expect(card.title).toBe(HILL_TEST_TITLE);
    expect(card.summary).toBe(HILL_TEST_SUMMARY);
    expect(card.options).toEqual([{ intent: HILL_TEST_OK, label: HILL_TEST_OK_LABEL }]);
    expect(HILL_TEST_EXPIRY_MS).toBe(600_000);
    expect(card.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(testCard(5000, null).requestId).not.toBe(card.requestId);
    expect(card.supersedes).toBeUndefined();
    expect(testCard(5000, "dc_abcdefghijkl").supersedes).toBe("dc_abcdefghijkl");
    expect(HILL_TEST_REF_HASH).toBe(createHash("sha256").update("collie hill test").digest("hex"));
    expect(testSender()).toEqual({ kind: "collie", ref: { type: "test", id: "test", hash: HILL_TEST_REF_HASH }, label: "Collie" });
  });

  test("the delay is the looking window and nine seconds, and the test is no card of a trick", () => {
    expect(LOOKING_MS).toBe(11_000);
    expect(HILL_TEST_DELAY_MS).toBe(20_000);
    expect(HILL_COLLIE_REF_TYPES).toContain("test");
    expect(HILL_OFF_TRICK_CARDS.test).toBe(false);
  });

  test("answers ok, and refuses any other intent in the usual words", () => {
    expect(answerTest("ok")).toEqual({ ok: true });
    expect(answerTest("yes")).toEqual({ ok: false, reason: "That is not an option of this card." });
  });
});

describe("a press", () => {
  test("answers at once, posts nothing yet, and posts the card after the delay: Now, fixed words, one push", () => {
    const r = rig();
    const answer = r.hill.requestTest("Pixel 9");
    expect(answer).toEqual({ ok: true, inSeconds: 20, rings: null });
    expect(r.timers.map((timer) => timer.ms)).toEqual([HILL_TEST_DELAY_MS]);
    expect(r.store.all()).toEqual([]);
    expect(r.pushes).toEqual([]);
    r.clock += HILL_TEST_DELAY_MS;
    r.fire();
    const [card] = openTests(r);
    expect(card).toMatchObject({ title: HILL_TEST_TITLE, summary: HILL_TEST_SUMMARY, priority: "now", state: "open", expiresAt: r.clock + HILL_TEST_EXPIRY_MS, from: { kind: "collie", label: "Collie", ref: { type: "test", id: "test", hash: HILL_TEST_REF_HASH } } });
    expect(card?.options).toMatchObject([{ intent: "ok", label: "It works" }]);
    expect(r.pushes).toHaveLength(1);
    expect(r.pushes[0]).toMatchObject({ title: HILL_TEST_TITLE, target: "hill", decision: card?.id });
    expect(r.audit.filter((entry) => entry.action === "hill.test")).toEqual([{ action: "hill.test", device: "Pixel 9", detail: { rings: "yes" } }]);
  });

  test("a second press while one waits schedules nothing and answers with the seconds that remain", () => {
    const r = rig();
    r.hill.requestTest();
    r.clock += 12_300;
    expect(r.hill.requestTest()).toEqual({ ok: true, inSeconds: 8, rings: null });
    r.clock += 7_000;
    expect(r.hill.requestTest()).toEqual({ ok: true, inSeconds: 1, rings: null });
    expect(r.timers).toHaveLength(1);
    expect(r.audit.filter((entry) => entry.action === "hill.test")).toHaveLength(1);
    // Once it posted, the next press schedules a new one.
    r.clock += 700;
    r.fire();
    expect(r.hill.requestTest()).toEqual({ ok: true, inSeconds: 20, rings: null });
    expect(r.timers).toHaveLength(2);
  });

  test("a second test supersedes the open one: at most one test card is open, and its notification slot is kept", () => {
    const r = rig();
    r.hill.requestTest();
    r.fire();
    const [first] = openTests(r);
    r.clock += 60_000;
    r.hill.requestTest();
    r.fire();
    const open = openTests(r);
    expect(open).toHaveLength(1);
    expect(open[0]?.supersedes).toBe(first?.id);
    expect(r.store.get(first!.id)).toMatchObject({ state: "superseded", supersededBy: open[0]?.id });
    expect(open[0]?.pushTag).toBe(first?.pushTag);
    expect(r.pushes).toHaveLength(2);
  });

  test("a closed test card is not replaced: the next one stands alone", () => {
    const r = rig();
    r.hill.requestTest();
    r.fire();
    const [first] = openTests(r);
    expect(r.hill.withdrawCollie(testSender(), first!.id, "test")).toMatchObject({ ok: true });
    r.hill.requestTest();
    r.fire();
    expect(openTests(r)).toHaveLength(1);
    expect(openTests(r)[0]?.supersedes).toBeNull();
  });
});

describe("the card's end", () => {
  test("It works closes it as answered, with delivery none, and Collie's handler took the intent", async () => {
    const r = rig();
    r.hill.requestTest();
    r.fire();
    const [card] = openTests(r);
    const outcome = await r.hill.answer({ rid: "00000000-0000-4000-8000-000000000001", node: `hill/${card!.id}`, intent: "ok", value: { text: null } }, card!.id, "Pixel 9");
    expect(outcome).toMatchObject({ kind: "receipt", receipt: { code: "ok", state: "answered", delivery: "none" } });
    expect(r.store.get(card!.id)).toMatchObject({ state: "answered" });
    expect(openTests(r)).toEqual([]);
  });

  test("an intent that is no option is rejected and the card stays open", async () => {
    const r = rig();
    r.hill.requestTest();
    r.fire();
    const [card] = openTests(r);
    const outcome = await r.hill.answer({ rid: "00000000-0000-4000-8000-000000000002", node: `hill/${card!.id}`, intent: "yes", value: { text: null } }, card!.id, "Pixel 9");
    expect(outcome).toMatchObject({ kind: "receipt", receipt: { code: "rejected" } });
    expect(openTests(r)).toHaveLength(1);
  });

  test("dismiss closes it", async () => {
    const r = rig();
    r.hill.requestTest();
    r.fire();
    const [card] = openTests(r);
    const outcome = await r.hill.answer({ rid: "00000000-0000-4000-8000-000000000003", node: `hill/${card!.id}`, intent: "dismiss", value: { text: null } }, card!.id, "Pixel 9");
    expect(outcome).toMatchObject({ kind: "receipt", receipt: { code: "ok", state: "dismissed" } });
    expect(openTests(r)).toEqual([]);
  });

  test("it expires after ten minutes with nobody's answer", () => {
    const r = rig();
    r.hill.requestTest();
    r.fire();
    const [card] = openTests(r);
    r.clock += HILL_TEST_EXPIRY_MS - 1;
    expect(r.hill.sweep(r.clock)).toBe(0);
    r.clock += 1;
    expect(r.hill.sweep(r.clock)).toBe(1);
    expect(r.store.get(card!.id)).toMatchObject({ state: "expired" });
  });
});

describe("the refusals", () => {
  test("with the Hill off a press is refused hill_off and schedules nothing", () => {
    const r = rig();
    r.state.on = false;
    expect(r.hill.requestTest()).toEqual({ ok: false, code: "hill_off", error: HILL_OFF });
    expect(r.timers).toEqual([]);
    expect(r.audit.filter((entry) => entry.action === "hill.test")).toEqual([]);
  });

  test("a Hill switched off while the test waits posts nothing when the delay ends", () => {
    const r = rig();
    r.hill.requestTest();
    r.state.on = false;
    r.fire();
    expect(r.store.all()).toEqual([]);
    expect(r.pushes).toEqual([]);
  });

  test("a crew member is not the lead: not_on_lead", () => {
    const r = rig();
    r.state.mode = "peer";
    expect(r.hill.requestTest()).toEqual({ ok: false, code: "not_on_lead", error: NOT_ON_LEAD });
    expect(r.timers).toEqual([]);
  });

  test("the verdict names the first reason for each state, and the card still posts", () => {
    const r = rig();
    r.state.crew = "quiet";
    expect(r.hill.requestTest()).toMatchObject({ ok: true, rings: "quiet" });
    r.fire();
    expect(openTests(r)).toHaveLength(1);
    expect(r.pushes).toEqual([]);
  });
});

describe("why no notification is sent, in order", () => {
  const open: HillRingFacts = { push: true, pref: true, snoozed: false, member: false, devices: 1, crewState: "here", verdict: "send" };
  const cases: Array<[HillRingBlock, Partial<HillRingFacts>]> = [
    ["push_off", { push: false }],
    ["no_devices", { devices: 0 }],
    ["pref_off", { pref: false }],
    ["snoozed", { snoozed: true }],
    ["crew_member", { member: true }],
    ["quiet", { crewState: "quiet" }],
    ["away", { crewState: "away" }],
    ["rate", { verdict: "sender" }],
  ];

  test("none is the answer when every fact is open", () => {
    expect(hillRingBlock(open)).toBeNull();
  });

  test("each reason alone is named", () => {
    for (const [code, over] of cases) expect(hillRingBlock({ ...open, ...over })).toBe(code);
    for (const verdict of ["sender", "member", "crew", "total"] as const) expect(hillRingBlock({ ...open, verdict })).toBe("rate");
  });

  test("with every fact against it, the first reason in the order wins, and taking it away shows the next", () => {
    const steps: Array<[HillRingBlock, Partial<HillRingFacts>]> = [
      ["push_off", { push: true }],
      ["no_devices", { devices: 1 }],
      ["pref_off", { pref: true }],
      ["snoozed", { snoozed: false }],
      ["crew_member", { member: false }],
      ["quiet", { crewState: "away" }],
      ["away", { crewState: "here" }],
      ["rate", { verdict: "send" }],
    ];
    const facts = { push: false, pref: false, snoozed: true, member: true, devices: 0, crewState: "quiet", verdict: "total" } satisfies HillRingFacts;
    for (const [code, fix] of steps) {
      expect(hillRingBlock(facts)).toBe(code);
      Object.assign(facts, fix);
    }
    expect(hillRingBlock(facts)).toBeNull();
  });

  test("a fact that is absent is not asked: no devices fact means a real send's four", () => {
    expect(hillRingBlock({ push: true, pref: true, snoozed: false, member: false })).toBeNull();
  });

  test("the rate reason is the real push check's verdict for the test sender", () => {
    const r = rig();
    // Three notifications an hour from one sender: the test card's own sender is spent by its own posts.
    for (let i = 0; i < HILL_PUSH_RATE.perSender; i += 1) {
      r.hill.requestTest();
      r.fire();
    }
    expect(r.pushes).toHaveLength(HILL_PUSH_RATE.perSender);
    expect(r.hill.requestTest()).toMatchObject({ ok: true, rings: "rate" });
  });
});

describe("a stored test card", () => {
  test("passes the bridge's reader (parse.ts); the web's reader holds the same card in web/src/lib/hill/reader-test-card.test.ts", () => {
    const r = rig();
    r.hill.requestTest();
    r.fire();
    const [card] = openTests(r);
    // SAFETY: a stored decision is JSON; the round trip is what a load reads back.
    const json = JSON.parse(JSON.stringify(card)) as JsonValue;
    expect(readDecision(json, { collie: true })).toMatchObject({ id: card?.id, from: { kind: "collie", ref: { type: "test" } } });
  });
});

describe("POST /api/hill/test", () => {
  const ctx = { device: "Pixel 9", acceptEncoding: null };

  test("an empty body or {} is taken and answers { inSeconds, rings }", async () => {
    const r = rig();
    const first = hillTestRoute(r.hill, "", ctx);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ inSeconds: 20, rings: null });
    r.clock += 5_000;
    expect(await hillTestRoute(r.hill, "{}", ctx).json()).toEqual({ inSeconds: 15, rings: null });
    expect(r.timers).toHaveLength(1);
  });

  test("a body with any key, or no object, is 400 and schedules nothing", () => {
    const r = rig();
    for (const raw of ['{"title":"x"}', '{"a":1}', "[]", "null", "5", "not json", "\u0000"]) expect(hillTestRoute(r.hill, raw, ctx).status).toBe(400);
    expect(r.timers).toEqual([]);
  });

  test("the Hill off and a crew member are 409 with their code", async () => {
    const r = rig();
    r.state.on = false;
    const off = hillTestRoute(r.hill, "", ctx);
    expect(off.status).toBe(409);
    expect(await off.json()).toEqual({ code: "hill_off", error: HILL_OFF });
    r.state.on = true;
    r.state.mode = "peer";
    const peer = hillTestRoute(r.hill, "", ctx);
    expect(peer.status).toBe(409);
    expect(await peer.json()).toEqual({ code: "not_on_lead", error: NOT_ON_LEAD });
  });

  test("names the reason a notification would not be sent", async () => {
    const r = rig();
    r.state.devices = 0;
    expect(await hillTestRoute(r.hill, "", ctx).json()).toEqual({ inSeconds: 20, rings: "no_devices" });
  });

  test("without the hill, 404", () => {
    expect(hillTestRoute(undefined, "", ctx).status).toBe(404);
  });

  test("needs the write right: a device the allowlist does not name is refused, and the route asks the write gate first", () => {
    const config = { ...loadConfig({ HOME: "/tmp/collie-hill-test-home" }), deviceHeader: "x-device-id", deviceAllowlist: ["phone"] };
    const headers = { host: "collie.ts.net", origin: "https://collie.ts.net", "x-device-id": "tablet" };
    expect(guard(new Request("http://collie.ts.net/api/hill/test", { method: "POST", headers }), config, "write")!.status).toBe(403);
    // No agent, trick or crew member holds such a token: the route sits behind the same gate as the Hill's switch, first.
    const src = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");
    const at = src.indexOf('if (pathname === "/api/hill/test"');
    expect(at).toBeGreaterThan(0);
    const route = src.slice(at, at + 500);
    expect(route).toContain('browserGate("write")');
    expect(route.indexOf('browserGate("write")')).toBeLessThan(route.indexOf("hillTestRoute"));
    expect(route).toContain('if (host.kind === "member") return text(HILL_LOCAL_TEXT, 400);');
  });
});

describe("the wiring in bridge/index.ts", () => {
  const src = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf8");

  test("the test card's answer is dispatched before the version cards, and ready() asks the same function as the verdict", () => {
    const at = src.indexOf("onCollieAnswer: (ref, intent) =>");
    expect(at).toBeGreaterThan(0);
    const dispatch = src.slice(at, at + 900);
    expect(dispatch.indexOf('ref.type === "test"')).toBeGreaterThan(-1);
    expect(dispatch.indexOf('ref.type === "test"')).toBeLessThan(dispatch.indexOf("versionCards?.answer"));
    expect(dispatch).toContain("answerTest(intent)");
    expect(src).toContain("ready: () => hillRingBlock(hillPushGates()) === null,");
    expect(src).toContain("ringFacts: () => ({ ...hillPushGates(), devices: push.listSubscriptions().length }),");
  });
});
