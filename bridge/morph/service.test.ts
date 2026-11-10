import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { MORPH_BAD_SWITCH, MORPH_LOCAL_TEXT, MORPH_OFF_TEXT, morphListRoute, morphSwitchRoute, withMorphRev } from "../server.ts";
import type { SnapshotResponse } from "../types.ts";
import { MORPH_DRAWING_MAX_MS, MORPH_HINT_MAX, MORPH_NOTE_MAX } from "../../web/src/lib/morph/wire.ts";
import { MORPH_HEAD, MORPH_NO_SESSION, MORPH_NOT_ON_LEAD, morphHint, MorphService, sameSession, type MorphCrewMode, type MorphServiceDeps } from "./service.ts";
import { MorphStore } from "./store.ts";

const BIN = "/home/op/apps/collie/bin/collie";
/** The lane's own binary: 59 characters, the longest path the hint has to carry. */
const LANE_BIN = "/var/home/altan/projects/collie-workspace/collie/bin/collie";
const ONE = "local/%1#aaaa";
const TWO = "local/%2#bbbb";

const goodView = [
  { kind: "para", text: "Two tests fail", attrs: { role: "heading" } },
  { kind: "bar", kids: [{ kind: "button", attrs: { label: "Fix", intent: "reply", value: "Fix them." } }] },
];

/** What the fake world holds: the live sessions and the crew mode, changed by a test as it goes. */
interface World {
  readonly live: Set<string>;
  mode: MorphCrewMode;
}

interface Rig extends World {
  readonly morph: MorphService;
  readonly store: MorphStore;
  /** Move the service's clock on, in ms. */
  readonly advance: (ms: number) => void;
}

function rig(over: Partial<MorphServiceDeps> = {}): Rig {
  let clock = 1_000;
  const store = new MorphStore(null, () => clock);
  const r: World = { live: new Set([ONE, TWO]), mode: "solo" };
  const morph = new MorphService({
    store,
    // As walkyPlace: `local/%1` (no token) and the lead's own id name the same live session.
    place: (address) => {
      const bare = address.replace(/^[^/]+\//u, "local/").split("#")[0];
      const hit = [...r.live].find((live) => live.split("#")[0] === bare && (!address.includes("#") || live === address.replace(/^[^/]+\//u, "local/")));
      return hit === undefined ? null : { address: hit };
    },
    sessionsKnown: () => r.live.size > 0,
    crewMode: () => r.mode,
    binary: BIN,
    now: () => (clock += 1),
    ...over,
  });
  return Object.assign(r, { morph, store, advance: (ms: number) => void (clock += ms) });
}

describe("the hint", () => {
  test("is the tail only: where the rules are, with the session's own address filled in", () => {
    expect(morphHint(BIN, ONE)).toBe(`[rules: ${BIN} morph help --session ${ONE}]`);
    expect(MORPH_HEAD).toBe("[morph] from operator:");
  });

  test("the lane path with an address of 30 fits one line under the cap, with room to spare", () => {
    const address = `bluefin-hc/terminal_12345#ab12`;
    expect(address.length).toBe(30);
    const hint = morphHint(LANE_BIN, address);
    expect(LANE_BIN.length).toBe(59);
    expect(hint).toBe(`[rules: ${LANE_BIN} morph help --session ${address}]`);
    expect(hint.length).toBeLessThan(MORPH_HINT_MAX - 20);
    expect(hint).not.toContain("\n");
  });

  test("the hint of two sessions differs only in the address", () => {
    const one = morphHint(LANE_BIN, ONE);
    const two = morphHint(LANE_BIN, TWO);
    expect(one).not.toBe(two);
    expect(one.replace(ONE, "<s>")).toBe(two.replace(TWO, "<s>"));
  });

  test("quotes a path or an address a shell would split, and refuses a relative path or one too long for any wording", () => {
    expect(morphHint("/home/a b/bin/collie", ONE)).toContain("'/home/a b/bin/collie' morph help");
    expect(morphHint(BIN, "local/a b#aaaa")).toBe(`[rules: ${BIN} morph help --session 'local/a b#aaaa']`);
    expect(() => morphHint("bin/collie", ONE)).toThrow();
    expect(() => morphHint(`/${"x".repeat(150)}/collie`, ONE)).toThrow();
  });

  test("an address no shell word can carry gets the fallback without it", () => {
    expect(morphHint(BIN, "local/a'b#aaaa")).toBe(`[rules: ${BIN} morph help]`);
  });

  test("every served session carries the head and its own tail", () => {
    const r = rig();
    r.morph.setOn(ONE, true);
    r.morph.setOn(TWO, true);
    const served = r.morph.answer().sessions;
    expect(served.map((s) => s.head)).toEqual([MORPH_HEAD, MORPH_HEAD]);
    expect(served.map((s) => s.hint)).toEqual([morphHint(BIN, ONE), morphHint(BIN, TWO)]);
  });
});

describe("the session a request names", () => {
  const own = "local/%1#aaaa";

  test("matches with and without the token, and by the lead's own member id", () => {
    expect(sameSession({ own, given: "local/%1#aaaa" })).toBe(true);
    expect(sameSession({ own, given: "local/%1" })).toBe(true);
    expect(sameSession({ own: "lead/%1#aaaa", given: "local/%1#aaaa" })).toBe(true);
    expect(sameSession({ own: "lead/%1#aaaa", given: "lead/%1" })).toBe(true);
  });

  test("a token that does not match, another pane, another machine or a scope is another session", () => {
    expect(sameSession({ own, given: "local/%1#bbbb" })).toBe(false);
    expect(sameSession({ own, given: "local/%2#aaaa" })).toBe(false);
    expect(sameSession({ own, given: "other/%1#aaaa" })).toBe(false);
    expect(sameSession({ own: "lead/%1#aaaa", given: "other/%1#aaaa" })).toBe(false);
    expect(sameSession({ own, given: "all" })).toBe(false);
    expect(sameSession({ own, given: "repo#branch" })).toBe(false);
    expect(sameSession({ own: "local/%1", given: "local/%1#aaaa" })).toBe(false);
  });
});

describe("start", () => {
  test("sets the drawing, bumps the rev, and is taken while Morph is off", () => {
    const r = rig();
    const answer = r.morph.start(ONE, { note: "Checking the tests" });
    expect(answer.ok && answer.session).toMatchObject({ session: ONE, on: false, drawing: { note: "Checking the tests" } });
    expect(r.store.rev()).toBeDefined();
    const rev = r.store.rev();
    r.morph.start(ONE, { note: "Still checking" });
    expect(r.store.rev()).toBeGreaterThan(rev!);
    expect(r.morph.status(ONE).drawing?.note).toBe("Still checking");
  });

  test("a start with no note says only the time", () => {
    const r = rig();
    const answer = r.morph.start(ONE, { note: null });
    expect(answer.ok && answer.session.drawing?.note).toBeUndefined();
    expect(answer.ok && answer.session.drawing?.at).toBeDefined();
  });

  test("a note of two lines or past the cap is refused, and nothing is stored", () => {
    const r = rig();
    expect(r.morph.start(ONE, { note: "a\nb" })).toMatchObject({ ok: false, code: "bad_note" });
    expect(r.morph.start(ONE, { note: "x".repeat(MORPH_NOTE_MAX + 1) })).toMatchObject({ ok: false, code: "bad_note" });
    expect(r.morph.start(ONE, { note: "x".repeat(MORPH_NOTE_MAX) })).toMatchObject({ ok: true });
    expect(r.store.get(TWO)).toBeUndefined();
  });

  test("a show, a clear and switching off end it; switching on keeps it", () => {
    const r = rig();
    r.morph.setOn(ONE, true);
    r.morph.start(ONE, { note: "Drawing" });
    r.morph.setOn(ONE, true);
    expect(r.morph.status(ONE).drawing).toBeDefined();
    r.morph.show(ONE, { view: goodView, title: null });
    expect(r.morph.status(ONE).drawing).toBeUndefined();
    r.morph.start(ONE, { note: "Again" });
    r.morph.clear(ONE);
    expect(r.morph.status(ONE).drawing).toBeUndefined();
    r.morph.start(ONE, { note: "Once more" });
    r.morph.setOn(ONE, false);
    expect(r.morph.status(ONE).drawing).toBeUndefined();
  });

  test("a drawing is ended by an off even when Morph was already off", () => {
    const r = rig();
    r.morph.start(ONE, { note: "Drawing" });
    r.morph.setOn(ONE, false);
    expect(r.morph.status(ONE).drawing).toBeUndefined();
  });

  test("a drawing older than ten minutes is not served, with no timer, and its entry is then pruned at the next write", () => {
    const r = rig();
    r.morph.setOn(ONE, true);
    r.morph.start(ONE, { note: "Drawing" });
    r.advance(MORPH_DRAWING_MAX_MS - 1000);
    expect(r.morph.status(ONE).drawing).toBeDefined();
    r.advance(2000);
    expect(r.morph.status(ONE).drawing).toBeUndefined();
    expect(r.morph.answer().sessions[0]?.drawing).toBeUndefined();
    // Off with a stale drawing and nothing else: nothing left to say.
    r.morph.setOn(ONE, false);
    expect(r.morph.answer().sessions).toEqual([]);
  });

  test("survives in the state file as an optional field an older read ignores", () => {
    const r = rig();
    r.morph.start(ONE, { note: "Drawing" });
    const held = r.store.get(ONE);
    expect(held?.drawing?.note).toBe("Drawing");
    expect(Object.keys(JSON.parse(JSON.stringify(held)))).toContain("drawing");
  });

  test("a crew member refuses it", () => {
    const r = rig();
    r.mode = "peer";
    expect(r.morph.start(ONE, { note: null })).toMatchObject({ ok: false, code: "not_on_lead" });
  });
});

describe("show, clear, on, off", () => {
  test("a show is stored even while Morph is off, and its rev rises per session, also after a clear", () => {
    const r = rig();
    const first = r.morph.show(ONE, { view: goodView, title: "Tests" });
    expect(first.ok && first.session).toMatchObject({ session: ONE, on: false, view: { rev: 1, title: "Tests" } });
    r.morph.clear(ONE);
    expect(r.morph.status(ONE).view).toBeUndefined();
    const second = r.morph.show(ONE, { view: goodView, title: null });
    expect(second.ok && second.session.view?.rev).toBe(2);
    expect(second.ok && second.session.view?.title).toBeUndefined();
  });

  test("a bad view is refused with the parser's path and reason, and nothing is stored", () => {
    const r = rig();
    const answer = r.morph.show(ONE, { view: [{ kind: "bar", kids: [{ kind: "button", attrs: { label: "x" } }] }], title: null });
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.code).toBe("bad_view");
    expect(answer.error).toContain("/view/0/kids/0");
    expect(answer.refusals?.[0]?.path.startsWith("/view/0")).toBe(true);
    expect(r.store.rev()).toBeUndefined();
  });

  test("a title of two lines or past the cap is refused", () => {
    const r = rig();
    const answer = r.morph.show(ONE, { view: goodView, title: "a\nb" });
    expect(!answer.ok && answer.code).toBe("bad_title");
  });

  test("on and off switch the session; the rev moves only on a change", () => {
    const r = rig();
    expect(r.morph.setOn(ONE, true)).toMatchObject({ ok: true, session: { session: ONE, on: true } });
    const rev = r.store.rev();
    r.morph.setOn(ONE, true);
    expect(r.store.rev()).toBe(rev);
    r.morph.setOn(ONE, false);
    // Off, no screen, no show counted: nothing left to say, so the entry goes.
    expect(r.morph.answer().sessions).toEqual([]);
  });

  test("a crew member refuses every write", () => {
    const r = rig();
    r.mode = "peer";
    expect(r.morph.show(ONE, { view: goodView, title: null })).toMatchObject({ ok: false, code: "not_on_lead", error: MORPH_NOT_ON_LEAD });
    expect(r.morph.setOn(ONE, true)).toMatchObject({ ok: false, code: "not_on_lead" });
    expect(r.morph.switch({ session: ONE, on: true })).toMatchObject({ ok: false, status: 400 });
  });
});

describe("pruning", () => {
  test("a gone session is dropped at the next write, once sessions are listed", () => {
    const r = rig();
    r.morph.setOn(ONE, true);
    r.morph.setOn(TWO, true);
    r.live.delete(ONE);
    r.morph.show(TWO, { view: goodView, title: null });
    expect(r.morph.answer().sessions.map((s) => s.session)).toEqual([TWO]);
  });

  test("a bridge that lists no session yet forgets nothing", () => {
    const r = rig();
    r.morph.setOn(ONE, true);
    r.live.clear();
    r.morph.setOn(TWO, true);
    expect(r.morph.answer().sessions.map((s) => s.session)).toEqual([ONE, TWO]);
  });
});

describe("the phone's switch", () => {
  test("resolves the address to the live session and keys it by that", () => {
    const r = rig();
    const answer = r.morph.switch({ session: "local/%1", on: true });
    expect(answer).toMatchObject({ ok: true, session: { session: ONE, on: true } });
    expect(r.morph.status(ONE).on).toBe(true);
  });

  test("an address that names no live session here is a 404", () => {
    const r = rig();
    expect(r.morph.switch({ session: "local/%9#zzzz", on: true })).toEqual({ ok: false, status: 404, error: MORPH_NO_SESSION });
  });
});

describe("the routes", () => {
  test("GET lists every session with the hint; `since` equal to the rev answers the short form", async () => {
    const r = rig();
    expect(await morphListRoute(r.morph, null, null).json()).toEqual({ rev: 0, sessions: [] });
    r.morph.setOn(ONE, true);
    const rev = r.morph.rev()!;
    const list = await morphListRoute(r.morph, null, null).json();
    expect(list).toEqual({ rev, sessions: [{ session: ONE, on: true, head: MORPH_HEAD, hint: morphHint(BIN, ONE) }] });
    expect(await morphListRoute(r.morph, String(rev), null).json()).toEqual({ rev, unchanged: true, sessions: [] });
  });

  test("POST switches, refuses another shape with 400, an unknown session with 404", async () => {
    const r = rig();
    const ok = morphSwitchRoute(r.morph, { session: ONE, on: true }, null);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ session: ONE, on: true });
    const bad = morphSwitchRoute(r.morph, { session: ONE }, null);
    expect(bad.status).toBe(400);
    expect(await bad.text()).toBe(MORPH_BAD_SWITCH);
    expect(morphSwitchRoute(r.morph, { session: "local/%9", on: true }, null).status).toBe(404);
  });

  test("a bridge built without Morph answers 404 on both routes", async () => {
    const res = morphListRoute(undefined, null, null);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(MORPH_OFF_TEXT);
    expect(morphSwitchRoute(undefined, { session: ONE, on: true }, null).status).toBe(404);
    expect(MORPH_LOCAL_TEXT).toContain("this machine");
  });

  test("the snapshot carries morphRev only once there is one; absent, the body is the same bytes", () => {
    const body: SnapshotResponse = { bridge: "connected", agents: [], shellPanes: [], workspaces: [], tabs: [], sessions: [], ts: 5 };
    expect(JSON.stringify(withMorphRev(body, undefined))).toBe(JSON.stringify(body));
    expect(withMorphRev(body, 9)).toEqual({ ...body, morphRev: 9 });
  });

  test("the list sits behind the read gate and the switch behind the write gate, both before `?host=` and the body", () => {
    const src = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    const routeBody = (head: string): string => {
      const at = src.indexOf(head);
      expect(at).toBeGreaterThan(-1);
      expect(src.indexOf(head, at + head.length)).toBe(-1);
      return src.slice(at, src.indexOf("if (pathname ===", at + head.length));
    };
    const list = routeBody('if (pathname === "/api/morph" && req.method === "GET") {');
    expect(list.indexOf('browserGate("read")')).toBeGreaterThan(-1);
    expect(list.indexOf('browserGate("read")')).toBeLessThan(list.indexOf('host.kind === "member"'));
    const write = routeBody('if (pathname === "/api/morph/switch" && req.method === "POST") {');
    expect(write.indexOf('browserGate("write")')).toBeGreaterThan(-1);
    expect(write.indexOf('browserGate("write")')).toBeLessThan(write.indexOf("req.json()"));
    expect(write.indexOf('host.kind === "member"')).toBeLessThan(write.indexOf("req.json()"));
  });
});
