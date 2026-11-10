import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { MORPH_BAD_SWITCH, MORPH_LOCAL_TEXT, MORPH_OFF_TEXT, morphListRoute, morphSwitchRoute, withMorphRev } from "../server.ts";
import type { SnapshotResponse } from "../types.ts";
import { MORPH_HINT_MAX } from "../../web/src/lib/morph/wire.ts";
import { MORPH_NO_SESSION, MORPH_NOT_ON_LEAD, morphHint, MorphService, type MorphCrewMode, type MorphServiceDeps } from "./service.ts";
import { MorphStore } from "./store.ts";

const BIN = "/home/op/apps/collie/bin/collie";
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
  return Object.assign(r, { morph, store });
}

describe("the hint", () => {
  test("names the bridge's own binary twice, on one line under the cap, in the brief's words", () => {
    const hint = morphHint(BIN);
    expect(hint).toBe(`[morph: I read this on Collie's Morph view. Answer by drawing one screen: ${BIN} morph show <file.json>. Kinds and an example: ${BIN} morph help]`);
    expect(hint.length).toBeLessThan(MORPH_HINT_MAX);
  });

  test("falls to a shorter wording for a longer path, and keeps the absolute path", () => {
    const long = "/var/home/operator/.cache/collie-lab/morph/bin/collie";
    const hint = morphHint(long);
    expect(hint.length).toBeLessThan(MORPH_HINT_MAX);
    expect(hint).toContain(`${long} morph show <file.json>`);
    expect(hint).not.toContain("\n");
  });

  test("quotes a path with a blank, and refuses a relative one or one too long for any wording", () => {
    expect(morphHint("/home/a b/bin/collie")).toContain("'/home/a b/bin/collie' morph show");
    expect(() => morphHint("bin/collie")).toThrow();
    expect(() => morphHint(`/${"x".repeat(150)}/collie`)).toThrow();
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
    expect(list).toEqual({ rev, sessions: [{ session: ONE, on: true, hint: morphHint(BIN) }] });
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
