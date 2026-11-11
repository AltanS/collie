import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { server } from "@/test/setup";
import { fetchTricks, tapTrick } from "../api";
import type { JsonObject, JsonValue } from "../json";
import { LEGS_DOCUMENT, TRACKER_DOCUMENT } from "./fixtures";
import { isRequestId, parseTrickDocument, partKey, type TapRefusal, type TrickPart, type TricksReply, type WireTrickInfo, type WireTrickPart } from "./schema";
import { createTricksStore, SYNC_RETRY_MS, tapRefusalLine, useTrickParts, type TricksStore, type TapInput } from "./store";
import { readTricksReply, readTapReply } from "./wire";

/** The parts of a fixture document, as the bridge's parser accepted them. */
function partsOf(doc: JsonObject): TrickPart[] {
  return parseTrickDocument(doc).parts.map((p) => p.part);
}

const [LEGS_BELT, LEGS_SESSION] = partsOf(LEGS_DOCUMENT);
const [TRACKER_SESSION] = partsOf(TRACKER_DOCUMENT);

/** The legs session part with another subtitle: a new version of the same part. */
function legsSaying(subtitle: string): TrickPart {
  if (LEGS_SESSION?.at !== "session") throw new Error("the legs fixture has no session part");
  return { ...LEGS_SESSION, subtitle };
}

function wire(trick: string, value: TrickPart | undefined, rev: number, extra: Partial<WireTrickPart> = {}): WireTrickPart {
  if (value === undefined) throw new Error("fixture part missing");
  return { host: "lodge", trick, part: value.id, rev, value, asOf: "2026-11-08T09:41:00Z", fresh: "90s", ...extra };
}

const TRICKS: WireTrickInfo[] = [
  { host: "lodge", id: "legs", name: "Browser leg", icon: "flask", on: true, state: "ok", places: ["belt", "session"] },
  { host: "lodge", id: "tracker", name: "Tracker", icon: "file", on: true, state: "ok", places: ["session"] },
];

const BELT = wire("legs", LEGS_BELT, 3);
const LEGS = wire("legs", LEGS_SESSION, 2);
const TRACKER = wire("tracker", TRACKER_SESSION, 1);
const ALL = [BELT, LEGS, TRACKER].map(partKey);

function reply(rev: number, parts: WireTrickPart[], present: string[] = ALL, tricks: WireTrickInfo[] = TRICKS): TricksReply {
  return { rev, tricks, parts, present };
}

/** The fake bridge's `/api/tricks`: answers each `since` from a queue, and records what it was asked. */
/** A status the fake bridge answers with instead of a body. */
interface Refusal {
  status: number;
}

function serveTricks(...answers: (TricksReply | Refusal)[]): string[] {
  const asked: string[] = [];
  server.use(
    http.get(/\/api\/tricks$/, ({ request }) => {
      asked.push(new URL(request.url).searchParams.get("since") ?? "");
      const next = answers.shift();
      if (next === undefined) return HttpResponse.json({ error: "no more answers" }, { status: 500 });
      if ("status" in next) return HttpResponse.text("down", { status: next.status });
      return HttpResponse.json(JSON.parse(JSON.stringify(next)));
    }),
  );
  return asked;
}

let ids = 0;
function storeOf(clock: () => number = Date.now): TricksStore {
  ids = 0;
  return createTricksStore(
    {
      fetchTricks: (since) => fetchTricks(since),
      tapTrick,
      mintRequestId: () => `00000000-0000-4000-8000-${String((ids += 1)).padStart(12, "0")}`,
    },
    clock,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("syncTricks", () => {
  it("fetches everything first, then only the changes since the rev it holds", async () => {
    const store = storeOf();
    const changed = wire("legs", legsSaying("case 25 red"), 5);
    const asked = serveTricks(reply(3, [BELT, LEGS, TRACKER]), reply(5, [changed]));
    await store.syncTricks(3);
    expect(store.getState().rev).toBe(3);
    expect([...store.getState().parts.keys()]).toEqual(ALL);
    await store.syncTricks(5);
    expect(asked).toEqual(["0", "3"]);
    const held = store.getState().parts.get(partKey(LEGS));
    expect(held?.rev).toBe(5);
    expect(held?.value).toEqual(changed.value);
    // The parts that did not change are kept as they were.
    expect(store.getState().parts.get(partKey(BELT))).toEqual(BELT);
  });

  it("asks nothing while the snapshot's rev is the one it holds", async () => {
    const store = storeOf();
    const asked = serveTricks(reply(3, [BELT, LEGS, TRACKER]));
    await store.syncTricks(3);
    await store.syncTricks(3);
    await store.syncTricks(undefined);
    expect(asked).toEqual(["0"]);
  });

  it("drops a part whose key the reply no longer lists", async () => {
    const store = storeOf();
    serveTricks(reply(3, [BELT, LEGS, TRACKER]), reply(4, [], [partKey(LEGS), partKey(TRACKER)]));
    await store.syncTricks(3);
    await store.syncTricks(4);
    expect([...store.getState().parts.keys()]).toEqual([partKey(LEGS), partKey(TRACKER)]);
  });

  it("fetches everything again when the rev went down, because the bridge restarted", async () => {
    const store = storeOf();
    const fresh = wire("legs", LEGS_BELT, 1);
    const asked = serveTricks(reply(9, [BELT, LEGS, TRACKER]), reply(1, [fresh], [partKey(fresh)]));
    await store.syncTricks(9);
    await store.syncTricks(1);
    expect(asked).toEqual(["0", "0"]);
    expect([...store.getState().parts.values()]).toEqual([fresh]);
  });

  it("keeps what it holds when a fetch fails, and asks the same rev again only after a while", async () => {
    let now = 1_000_000;
    const store = storeOf(() => now);
    const asked = serveTricks(reply(3, [BELT, LEGS, TRACKER]), { status: 500 }, reply(4, [LEGS]));
    await store.syncTricks(3);
    await store.syncTricks(4);
    expect(store.getState().rev).toBe(3);
    expect(store.getState().parts.size).toBe(3);
    await store.syncTricks(4);
    expect(asked).toEqual(["0", "3"]);
    now += SYNC_RETRY_MS + 1;
    await store.syncTricks(4);
    expect(asked).toEqual(["0", "3", "3"]);
    expect(store.getState().rev).toBe(4);
  });

  it("waits after a failed fetch whatever rev the next snapshot names, and asks again once the time is up", async () => {
    let now = 1_000_000;
    const store = storeOf(() => now);
    const asked = serveTricks(reply(3, [BELT, LEGS, TRACKER]), { status: 500 }, reply(5, [LEGS]));
    await store.syncTricks(3);
    await store.syncTricks(4);
    expect(asked).toEqual(["0", "3"]);
    // A newer rev inside the window is not asked either: the route is broken, not the rev.
    now += 1_000;
    await store.syncTricks(5);
    expect(asked).toEqual(["0", "3"]);
    now += SYNC_RETRY_MS;
    await store.syncTricks(5);
    expect(asked).toEqual(["0", "3", "3"]);
    expect(store.getState().rev).toBe(5);
  });

  it("refuses a reply of another shape whole, and keeps what it holds", async () => {
    const store = storeOf();
    serveTricks(reply(3, [BELT, LEGS, TRACKER]));
    await store.syncTricks(3);
    // No `present` list and no `tricks` list: bad outside its parts, so nothing of it is applied.
    server.use(http.get(/\/api\/tricks$/, () => HttpResponse.json({ rev: 4, parts: [{ host: "lodge" }] })));
    await store.syncTricks(4);
    expect(store.getState().rev).toBe(3);
    expect(store.getState().parts.size).toBe(3);
  });

  it("drops one malformed part and keeps the rest of the reply, warning once for the rev", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = storeOf();
    const changed = wire("legs", legsSaying("case 25 red"), 5);
    const bad = { host: "lodge", trick: "legs", part: "broken", rev: 4, value: "not an object" };
    server.use(http.get(/\/api\/tricks$/, () => HttpResponse.json({ rev: 5, tricks: TRICKS, parts: [bad, changed, { nope: 1 }, BELT], present: [...ALL, "lodge/legs/broken"] })));
    await store.syncTricks(5);
    expect(store.getState().rev).toBe(5);
    expect([...store.getState().parts.keys()].toSorted()).toEqual([partKey(BELT), partKey(LEGS)].toSorted());
    expect(store.getState().parts.get(partKey(LEGS))?.rev).toBe(5);
    expect(warn).toHaveBeenCalledTimes(1);
    // The same bad reply read again does not warn again.
    await store.syncTricks(5);
    const again = storeOf();
    await again.syncTricks(5);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("keeps a held part's last good version when its new version is the malformed one", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = storeOf();
    serveTricks(reply(3, [BELT, LEGS, TRACKER]));
    await store.syncTricks(3);
    const bad = { host: "lodge", trick: "legs", part: LEGS.part, rev: 9, value: 7 };
    server.use(http.get(/\/api\/tricks$/, () => HttpResponse.json({ rev: 9, tricks: TRICKS, parts: [bad], present: ALL })));
    await store.syncTricks(9);
    expect(store.getState().rev).toBe(9);
    expect(store.getState().parts.get(partKey(LEGS))).toEqual(LEGS);
  });

  it("reads a tap's receipt whole when one part in it is malformed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = { rid: "r1", code: "ok", rev: 6, parts: [{ nope: 1 }, wire("legs", legsSaying("after the tap"), 6)] };
    server.use(http.post(/\/api\/tricks\/lodge\/legs\/tap$/, () => HttpResponse.json(JSON.parse(JSON.stringify(body)))));
    const got = await tapTrick("lodge", "legs", { rid: "r1", node: "legs", intent: "rerun" });
    expect(got.code).toBe("ok");
    expect(got.parts?.map((part) => part.rev)).toEqual([6]);
  });

  it("runs no timer of its own", async () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const store = storeOf();
    serveTricks(reply(3, [BELT, LEGS, TRACKER]));
    const before = timeout.mock.calls.length;
    await store.syncTricks(3);
    expect(interval).not.toHaveBeenCalled();
    // The only timeouts are the request's own deadline (lib/env.ts), none of the store's.
    expect(timeout.mock.calls.length - before).toBeLessThanOrEqual(1);
  });
});

/** The fake bridge's tap route: answers each POST from a queue, after an optional gate, and records the bodies. */
function serveTaps(...answers: (JsonValue | Promise<JsonValue>)[]): JsonObject[] {
  const bodies: JsonObject[] = [];
  server.use(
    http.post<never, JsonObject>(/\/api\/tricks\/lodge\/legs\/tap$/, async ({ request }) => {
      bodies.push(await request.json());
      const next = answers.shift();
      if (next === undefined) return HttpResponse.json({ error: "no more answers" }, { status: 500 });
      return HttpResponse.json(await next);
    }),
  );
  return bodies;
}

const RERUN: TapInput = { host: "lodge", trick: "legs", part: "legs", intent: "rerun", value: "red", control: "v/6", rev: 2 };

function receipt(rid: string, code: string, extra: JsonObject = {}): JsonValue {
  return { rid, code, ...extra };
}

const ID1 = "00000000-0000-4000-8000-000000000001";
const ID2 = "00000000-0000-4000-8000-000000000002";

async function heldStore(): Promise<TricksStore> {
  const store = storeOf();
  serveTricks(reply(3, [BELT, LEGS, TRACKER]));
  await store.syncTricks(3);
  return store;
}

describe("a tap", () => {
  it("posts its rid, node, intent and value, and applies the reply's parts at once", async () => {
    const store = await heldStore();
    const after = wire("legs", legsSaying("rerunning"), 6);
    const bodies = serveTaps(receipt(ID1, "ok", { rev: 6, parts: JSON.parse(JSON.stringify([after])), present: [partKey(BELT), partKey(LEGS)] }));
    const outcome = await store.tap(RERUN);
    expect(outcome).toBe("ok");
    expect(bodies).toEqual([{ rid: ID1, node: "legs", intent: "rerun", value: "red", rev: 2 }]);
    expect(isRequestId(ID1)).toBe(true);
    expect(store.getState().parts.get(partKey(LEGS))?.value).toEqual(after.value);
    // Only this trick's parts answer to its `present`; the tracker's part stays.
    expect(store.getState().parts.has(partKey(TRACKER))).toBe(true);
    expect(store.getState().taps.size).toBe(0);
    // The held rev stays, so the next snapshot's delta still brings the other tricks' changes.
    expect(store.getState().rev).toBe(3);
  });

  it("is busy on its control until the reply lands, and a second tap meanwhile does nothing", async () => {
    const store = await heldStore();
    let release: (value: JsonValue) => void = () => {};
    const gate = new Promise<JsonValue>((resolve) => {
      release = resolve;
    });
    const bodies = serveTaps(gate);
    const first = store.tap(RERUN);
    expect(store.getState().taps.get(partKey(LEGS))).toMatchObject({ phase: "busy", control: "v/6", rid: ID1 });
    await expect(store.tap(RERUN)).resolves.toBe("ignored");
    await expect(store.tap({ ...RERUN, control: "v/4/0", intent: "open-case" })).resolves.toBe("ignored");
    await waitFor(() => expect(bodies).toHaveLength(1));
    release(receipt(ID1, "ok"));
    await expect(first).resolves.toBe("ok");
    expect(bodies).toHaveLength(1);
    expect(store.getState().taps.size).toBe(0);
  });

  it("applies a changed receipt the same way, and a stray draft or open in it reaches nothing: the handlers have no such hook", async () => {
    const store = await heldStore();
    serveTaps(receipt(ID1, "changed", { draft: { session: "lodge:w6X:3", text: "fix case 24" }, open: { url: "http://lodge:8080/" } }));
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    await expect(store.tap(RERUN, { from: { session: "lodge:w6X:3" } })).resolves.toBe("changed");
    expect(open).not.toHaveBeenCalled();
    expect(store.getState().taps.size).toBe(0);
    open.mockRestore();
  });

  it("sends the session open on the phone", async () => {
    const store = await heldStore();
    const bodies = serveTaps(receipt(ID1, "ok"));
    await store.tap(RERUN, { from: { session: "lodge:w6X:3" } });
    expect(bodies[0]).toMatchObject({ from: { session: "lodge:w6X:3" } });
  });

  it("keeps a failed receipt's masked reason for the frame", async () => {
    const store = await heldStore();
    serveTaps(receipt(ID1, "rejected", { message: "rerun.sh: exit 2" }));
    await expect(store.tap(RERUN)).resolves.toBe("rejected");
    expect(store.getState().taps.get(partKey(LEGS))).toMatchObject({ phase: "failed", message: "rerun.sh: exit 2", control: "v/6" });
  });

  it("shows an unknown outcome and never sends it again on its own", async () => {
    const store = await heldStore();
    const bodies = serveTaps(receipt(ID1, "unknown"));
    await expect(store.tap(RERUN)).resolves.toBe("unknown");
    expect(store.getState().taps.get(partKey(LEGS))).toMatchObject({ phase: "unknown", control: "v/6" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await store.syncTricks(3);
    expect(bodies).toHaveLength(1);
  });

  it("sends the SAME request id when the person taps that control again after an unknown", async () => {
    const store = await heldStore();
    const bodies = serveTaps(receipt(ID1, "unknown"), receipt(ID1, "ok"), receipt(ID2, "ok"));
    await store.tap(RERUN);
    await expect(store.tap(RERUN)).resolves.toBe("ok");
    await store.tap(RERUN);
    expect(bodies.map((body) => body.rid)).toEqual([ID1, ID1, ID2]);
  });

  it("reads no answer, a deadline or a 5xx as unknown, and a 4xx as failed", async () => {
    const store = await heldStore();
    server.use(http.post(/\/tap$/, () => HttpResponse.error()));
    await expect(store.tap(RERUN)).resolves.toBe("unknown");
    server.use(http.post(/\/tap$/, () => HttpResponse.text("boom", { status: 502 })));
    await expect(store.tap({ ...RERUN, control: "v/4/0" })).resolves.toBe("unknown");
    server.use(http.post(/\/tap$/, () => HttpResponse.text("no such trick", { status: 404 })));
    await expect(store.tap({ ...RERUN, control: "v/3" })).resolves.toBe("rejected");
    expect(store.getState().taps.get(partKey(LEGS))).toMatchObject({ phase: "failed", message: "The bridge refused the tap (404)." });
  });

  it("reads a receipt that came back on a refusal status as the receipt", async () => {
    const store = await heldStore();
    server.use(http.post(/\/tap$/, () => HttpResponse.json(receipt(ID1, "rejected", { message: "trick is off" }), { status: 409 })));
    await expect(store.tap(RERUN)).resolves.toBe("rejected");
    expect(store.getState().taps.get(partKey(LEGS))).toMatchObject({ message: "trick is off" });
  });

  it("reads a receipt for another request as unknown", async () => {
    const store = await heldStore();
    serveTaps(receipt(ID2, "ok"));
    await expect(store.tap(RERUN)).resolves.toBe("unknown");
  });

  it("clears a failed or unknown tap when a newer version of its part arrives", async () => {
    const store = storeOf();
    serveTricks(reply(3, [BELT, LEGS, TRACKER]), reply(4, [wire("legs", LEGS_SESSION, 4)]));
    await store.syncTricks(3);
    serveTaps(receipt(ID1, "unknown"));
    await store.tap(RERUN);
    await store.syncTricks(4);
    expect(store.getState().taps.size).toBe(0);
  });
});

describe("fault A: a refused tap", () => {
  it("fault A: sends the rev of the part as the phone drew it, and none for a control drawn from no held part", async () => {
    const store = await heldStore();
    const bodies = serveTaps(receipt(ID1, "ok"), receipt(ID2, "changed", { refused: "changed" }));
    await store.tap(RERUN);
    await store.tap({ ...RERUN, part: "ghost", rev: undefined });
    expect(bodies[0]).toMatchObject({ rev: LEGS.rev });
    expect(bodies[1]).not.toHaveProperty("rev");
  });

  it("fault A: keeps each refusal word for the frame line, with Collie's own words and never the bridge's", async () => {
    const lines: [TapRefusal, string][] = [
      ["part", "This is gone from the trick. Nothing ran."],
      ["intent", "The trick does not take that tap. Nothing ran."],
      ["value", "The trick does not take that value. Nothing ran."],
      ["session", "No open agent session here. Nothing ran."],
    ];
    for (const [word, line] of lines) {
      const store = await heldStore();
      serveTaps(receipt(ID1, "rejected", { refused: word, message: "The bridge's English line" }));
      await expect(store.tap(RERUN)).resolves.toBe("rejected");
      expect(store.getState().taps.get(partKey(LEGS))).toEqual({ phase: "failed", rid: ID1, control: "v/6", intent: "rerun", value: "red", refused: word, message: line });
      expect(tapRefusalLine(word)).toBe(line);
    }
  });

  it("fault A: changed draws the trick's parts now, keeps its line until the part moves again, and sends nothing again by itself", async () => {
    const store = await heldStore();
    const now = wire("legs", legsSaying("moved"), 7);
    const bodies = serveTaps(receipt(ID1, "changed", { refused: "changed", rev: 7, parts: JSON.parse(JSON.stringify([now])), present: [partKey(BELT), partKey(LEGS)] }), receipt(ID2, "ok"));
    await expect(store.tap(RERUN)).resolves.toBe("changed");
    expect(store.getState().parts.get(partKey(LEGS))?.value).toEqual(now.value);
    expect(store.getState().taps.get(partKey(LEGS))).toMatchObject({ phase: "failed", refused: "changed", message: "This changed before your tap. Nothing ran." });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bodies).toHaveLength(1);
    // A tap on the new face goes out with a new request id and the new rev.
    await expect(store.tap({ ...RERUN, rev: 7 })).resolves.toBe("ok");
    expect(bodies[1]).toMatchObject({ rid: ID2, rev: 7 });
  });

  it("N4: a tap sends the rev of the part its control was drawn from, not the newer one the store holds", async () => {
    const store = await heldStore();
    // The store moved on (a newer copy arrived) while the person's finger was on the old face.
    serveTricks(reply(4, [BELT, wire("legs", legsSaying("newer"), 9), TRACKER]));
    await store.syncTricks(4);
    expect(store.getState().parts.get(partKey(LEGS))?.rev).toBe(9);
    const bodies = serveTaps(receipt(ID1, "ok"));
    await store.tap(RERUN);
    expect(bodies[0]).toMatchObject({ rid: ID1, rev: 2 });
  });

  it("fault A: reads a refusal word this phone does not know as a plain receipt", () => {
    expect(readTapReply({ rid: ID1, code: "rejected", refused: "planet", message: "x" })).toEqual({ rid: ID1, code: "rejected", message: "x" });
    expect(readTapReply({ rid: ID1, code: "changed", refused: "changed" })).toEqual({ rid: ID1, code: "changed", refused: "changed" });
  });
});

describe("useTrickParts", () => {
  it("gives one place's parts in the trick list's order, and none of a trick that is off", async () => {
    const store = storeOf();
    serveTricks(reply(3, [TRACKER, BELT, LEGS]));
    await store.syncTricks(3);
    const sessions = renderHook(() => useTrickParts("session", undefined, store));
    expect(sessions.result.current.map((part) => part.trick)).toEqual(["legs", "tracker"]);
    const belt = renderHook(() => useTrickParts("belt", undefined, store));
    expect(belt.result.current.map(partKey)).toEqual([partKey(BELT)]);
    serveTricks(reply(4, [], ALL, [TRICKS[0]!, { ...TRICKS[1]!, on: false }]));
    await store.syncTricks(4);
    sessions.rerender();
    expect(sessions.result.current.map((part) => part.trick)).toEqual(["legs"]);
  });
});

describe("B7: a bridge that runs no tricks", () => {
  it("keeps the reply's word on where they run, and drops it once a reply no longer says it", async () => {
    const store = storeOf();
    serveTricks({ ...reply(3, [BELT, LEGS, TRACKER]), runsOn: { lead: "desk" } }, reply(4, []));
    await store.syncTricks(3);
    expect(store.getState().runsOn).toEqual({ lead: "desk" });
    await store.syncTricks(4);
    expect(store.getState().runsOn).toBeUndefined();
  });

  it("reads the word tolerantly: an unknown lead stays `{}`, a malformed one is left out and the reply kept", () => {
    const base = { rev: 1, parts: [], present: [], tricks: [] };
    expect(readTricksReply({ ...base, runsOn: { lead: "desk" } })?.runsOn).toEqual({ lead: "desk" });
    expect(readTricksReply({ ...base, runsOn: {} })?.runsOn).toEqual({});
    expect(readTricksReply({ ...base, runsOn: { lead: 7 } })?.runsOn).toEqual({});
    expect(readTricksReply({ ...base, runsOn: "desk" })).toEqual(base);
  });
});

describe("the wire readers", () => {
  it("read the fixtures' replies and refuse a body of another shape", () => {
    expect(readTricksReply(JSON.parse(JSON.stringify(reply(3, [BELT]))))).toEqual(reply(3, [BELT]));
    expect(readTricksReply({ rev: 1, parts: [], present: "x", tricks: [] })).toBeUndefined();
    expect(readTricksReply({ rev: 1, parts: [], present: [], tricks: [{ host: "lodge" }] })).toBeUndefined();
    expect(readTapReply({ rid: ID1, code: "maybe" })).toBeUndefined();
    expect(readTapReply({ requestId: ID1, outcome: "applied" })).toBeUndefined();
    expect(readTapReply({ rid: ID1, code: "ok", open: { session: "trick:lodge:legs" } })).toEqual({ rid: ID1, code: "ok" });
  });

  it("keep a part of a kind this Collie does not know, for the placeholder to draw", () => {
    const newer = { host: "lodge", trick: "legs", part: "legs", rev: 1, value: { at: "session", id: "legs", view: [{ kind: "hologram" }] } };
    expect(readTricksReply({ rev: 1, parts: [newer], present: ["lodge/legs/legs"], tricks: [] })?.parts).toHaveLength(1);
  });
});
