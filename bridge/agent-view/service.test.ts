import { describe, expect, test } from "bun:test";

import { VIEW_DRAWING_MAX_MS, VIEW_HINT_MAX, VIEW_NOTE_MAX, type TrickViewSession } from "../../web/src/lib/agent-view/wire.ts";
import {
  AgentViewService,
  readStartFields,
  sameSession,
  viewHead,
  viewHeadBare,
  viewHint,
  VIEW_NO_SESSION,
  VIEW_NOT_ON_LEAD,
  VIEW_OFF_WORDS,
  type AgentViewServiceDeps,
  type ViewAuditEntry,
  type ViewCrewMode,
  type ViewGate,
} from "./service.ts";
import { AgentViewStore } from "./store.ts";
import { trickViewsListRoute, trickViewsSwitchRoute } from "../server.ts";
import type { JsonValue } from "../json.ts";

const BIN = "/home/op/apps/collie/bin/collie";
/** The lane's own binary: 59 characters, the longest path the hint has to carry. */
const LANE_BIN = "/var/home/altan/projects/collie-workspace/collie/bin/collie";
const ONE = "local/%1#aaaa";
const TWO = "local/%2#bbbb";
const T = "morph";
const OTHER = "notes";
const RULES = "Draw one screen.\n";

const goodView = [
  { kind: "para", text: "Two tests fail", attrs: { role: "heading" } },
  { kind: "bar", kids: [{ kind: "button", attrs: { label: "Fix them", intent: "reply" } }] },
];

/** The gate of one trick in the fake world: its approved rules text, or the reason it is shut. */
type GateState = { readonly rules: string } | { readonly code: "no_trick" | "trick_off" | "not_a_view" };

/** What the fake world holds: the live sessions, the crew mode and the gates, changed by a test as it goes. */
interface World {
  readonly live: Set<string>;
  mode: ViewCrewMode;
  readonly gates: Map<string, GateState>;
  readonly audits: ViewAuditEntry[];
  readonly helpCalls: Parameters<AgentViewServiceDeps["helpOf"]>[0][];
}

interface Rig extends World {
  readonly service: AgentViewService;
  readonly store: AgentViewStore;
  /** Move the service's clock on, in ms. */
  readonly advance: (ms: number) => void;
}

const rulesIdOf = (trick: string, rules: string): string => `rid-${trick}-${String(rules.length)}`;

function gateRead(gates: Map<string, GateState>, trick: string): ViewGate {
  const state = gates.get(trick);
  if (state === undefined) return { ok: false, code: "no_trick", error: `no trick ${trick} is known here` };
  if ("code" in state) return { ok: false, code: state.code, error: `the trick ${trick} is shut: ${state.code}` };
  return { ok: true, name: "Morph", rules: state.rules };
}

function rig(over: Partial<AgentViewServiceDeps> = {}): Rig {
  let clock = 1_000;
  const store = new AgentViewStore(null, () => clock);
  const world: World = {
    live: new Set([ONE, TWO]),
    mode: "solo",
    gates: new Map<string, GateState>([
      [T, { rules: RULES }],
      [OTHER, { rules: RULES }],
    ]),
    audits: [],
    helpCalls: [],
  };
  const service = new AgentViewService({
    store,
    // As walkyPlace: `local/%1` (no token) and the lead's own id name the same live session.
    place: (address) => {
      const bare = address.replace(/^[^/]+\//u, "local/").split("#")[0];
      const hit = [...world.live].find((live) => live.split("#")[0] === bare && (!address.includes("#") || live === address.replace(/^[^/]+\//u, "local/")));
      return hit === undefined ? null : { address: hit };
    },
    sessionsKnown: () => world.live.size > 0,
    crewMode: () => world.mode,
    binary: BIN,
    gate: { check: (trick) => gateRead(world.gates, trick), fresh: async (trick) => gateRead(world.gates, trick) },
    rulesIdOf,
    helpOf: (input) => {
      world.helpCalls.push(input);
      return ["help"];
    },
    audit: (entry) => world.audits.push(entry),
    now: () => (clock += 1),
    ...over,
  });
  return Object.assign(world, { service, store, advance: (ms: number) => void (clock += ms) });
}

/** The person switches a view on, as the phone does. */
async function on(r: Rig, session: string, trick = T): Promise<TrickViewSession> {
  const answer = await r.service.switch({ trick, session, on: true }, null);
  if (!answer.ok) throw new Error(`switch refused: ${answer.error}`);
  return answer.session;
}

const served = (r: Rig, session: string, trick = T) => r.service.answer().views.find((s) => s.session === session && s.trick === trick);

describe("the hint", () => {
  test("is the tail only: where the rules are, with the trick and the session's own address filled in", () => {
    expect(viewHint(BIN, T, ONE)).toBe(`[rules: ${BIN} trick view ${T} help --session ${ONE}]`);
    expect(viewHeadBare(T)).toBe("[view:morph] from operator:");
  });

  test("the lane path with an address of 30 fits one line under the cap, with room to spare", () => {
    const address = `lodge-hc-1/terminal_12345#ab12`;
    expect(address.length).toBe(30);
    const hint = viewHint(LANE_BIN, T, address);
    expect(LANE_BIN.length).toBe(59);
    expect(hint).toBe(`[rules: ${LANE_BIN} trick view ${T} help --session ${address}]`);
    expect(hint.length).toBeLessThan(VIEW_HINT_MAX - 20);
    expect(hint).not.toContain("\n");
  });

  test("the hint of two sessions differs only in the address", () => {
    const one = viewHint(LANE_BIN, T, ONE);
    const two = viewHint(LANE_BIN, T, TWO);
    expect(one).not.toBe(two);
    expect(one.replace(ONE, "<s>")).toBe(two.replace(TWO, "<s>"));
  });

  test("the hint of two tricks names each trick", () => {
    expect(viewHint(BIN, OTHER, ONE)).toBe(`[rules: ${BIN} trick view ${OTHER} help --session ${ONE}]`);
    expect(viewHint(BIN, OTHER, ONE)).not.toBe(viewHint(BIN, T, ONE));
  });

  test("quotes a path or an address a shell would split, and refuses a relative path or one too long for any wording", () => {
    expect(viewHint("/home/a b/bin/collie", T, ONE)).toContain("'/home/a b/bin/collie' trick view morph help");
    expect(viewHint(BIN, T, "local/a b#aaaa")).toBe(`[rules: ${BIN} trick view ${T} help --session 'local/a b#aaaa']`);
    expect(() => viewHint("bin/collie", T, ONE)).toThrow();
    expect(() => viewHint(`/${"x".repeat(190)}/collie`, T, ONE)).toThrow();
  });

  test("an address no shell word can carry gets the fallback without it", () => {
    expect(viewHint(BIN, T, "local/a'b#aaaa")).toBe(`[rules: ${BIN} trick view ${T} help]`);
  });

  test("every served view carries the head and its own tail", async () => {
    const r = rig();
    await on(r, ONE);
    await on(r, TWO);
    const views = r.service.answer().views;
    expect(views.map((s) => s.head)).toEqual([`[view:${T} ${ONE}] from operator:`, `[view:${T} ${TWO}] from operator:`]);
    expect(views.map((s) => s.hint)).toEqual([viewHint(BIN, T, ONE), viewHint(BIN, T, TWO)]);
  });

  test("the head names the trick and the session, quoted as the tail quotes it; one that cannot carry it is the bare head", () => {
    expect(viewHead(T, ONE)).toBe("[view:morph local/%1#aaaa] from operator:");
    expect(viewHead(T, "local/a b#aaaa")).toBe("[view:morph 'local/a b#aaaa'] from operator:");
    expect(viewHead(T, "local/a'b#aaaa")).toBe(viewHeadBare(T));
    expect(viewHead(T, `local/${"x".repeat(140)}#aaaa`)).toBe(viewHeadBare(T));
  });
});

describe("the rules handshake", () => {
  const ID = rulesIdOf(T, RULES);

  /** A rig with a pane mark the test moves. */
  function handshake(): Rig & { marks: Map<string, string | null> } {
    const marks = new Map<string, string | null>([
      [ONE, "claude\u0000id:conv-1"],
      [TWO, "codex\u0000"],
    ]);
    const r = rig({ paneMark: (session) => marks.get(session) ?? null });
    return Object.assign(r, { marks });
  }

  test("a start with the current rules id drops the tail of the next request; the head stays", async () => {
    const r = handshake();
    await on(r, ONE);
    expect(served(r, ONE)?.hint).toBe(viewHint(BIN, T, ONE));
    const before = r.service.rev();
    expect((await r.service.start(T, ONE, { note: "Drawing", rules: ID })).ok).toBe(true);
    expect(r.service.rev()).not.toBe(before);
    expect(served(r, ONE)).toMatchObject({ head: `[view:${T} ${ONE}] from operator:` });
    expect(served(r, ONE)?.hint).toBeUndefined();
    expect(r.service.status(T, ONE).hint).toBeUndefined();
    // Another session is its own.
    await on(r, TWO);
    expect(served(r, TWO)?.hint).toBe(viewHint(BIN, T, TWO));
  });

  test("a missing or another id is no refusal: the start works and the tail stays; a later start without the id brings it back", async () => {
    const r = handshake();
    await on(r, ONE);
    expect((await r.service.start(T, ONE, { note: "Drawing", rules: "deadbeef" })).ok).toBe(true);
    expect(served(r, ONE)?.hint).toBe(viewHint(BIN, T, ONE));
    expect((await r.service.start(T, ONE, { note: "Drawing", rules: ID })).ok).toBe(true);
    expect(served(r, ONE)?.hint).toBeUndefined();
    expect((await r.service.start(T, ONE, { note: "Again", rules: null })).ok).toBe(true);
    expect(served(r, ONE)?.hint).toBe(viewHint(BIN, T, ONE));
  });

  test("the id is the trick's own: another trick's id proves nothing, and a change of the approved rules ends the proof", async () => {
    const r = handshake();
    await on(r, ONE);
    await r.service.start(T, ONE, { note: "Drawing", rules: rulesIdOf(OTHER, RULES) });
    expect(served(r, ONE)?.hint).toBe(viewHint(BIN, T, ONE));
    await r.service.start(T, ONE, { note: "Drawing", rules: ID });
    expect(served(r, ONE)?.hint).toBeUndefined();
    // The author's rules change (a new version, approved): the proof is for the old text.
    r.gates.set(T, { rules: `${RULES}Draw it twice.\n` });
    expect(served(r, ONE)?.hint).toBe(viewHint(BIN, T, ONE));
  });

  test("off and clear end the proof, and move the revision", async () => {
    const r = handshake();
    await on(r, ONE);
    await r.service.start(T, ONE, { note: "Drawing", rules: ID });
    expect((await r.service.clear(T, ONE)).ok).toBe(true);
    expect(served(r, ONE)?.hint).toBe(viewHint(BIN, T, ONE));

    // A show keeps the proof; a clear of the screen ends it, and the phone learns it by the revision.
    await r.service.start(T, ONE, { note: "Drawing", rules: ID });
    await r.service.show(T, ONE, { view: goodView, title: null });
    expect(served(r, ONE)?.hint).toBeUndefined();
    const rev = r.service.rev();
    expect((await r.service.clear(T, ONE)).ok).toBe(true);
    expect(r.service.rev()).not.toBe(rev);
    expect(served(r, ONE)?.hint).toBe(viewHint(BIN, T, ONE));

    await r.service.start(T, ONE, { note: "Drawing", rules: ID });
    expect((await r.service.switch({ trick: T, session: ONE, on: false }, null)).ok).toBe(true);
    await on(r, ONE);
    expect(served(r, ONE)?.hint).toBe(viewHint(BIN, T, ONE));
  });

  test("another conversation or another harness in the pane ends the proof at the next look, and the revision moves", async () => {
    const r = handshake();
    await on(r, ONE);
    await r.service.start(T, ONE, { note: "Drawing", rules: ID });
    r.service.noteMarks();
    expect(served(r, ONE)?.hint).toBeUndefined();

    r.marks.set(ONE, "claude\u0000id:conv-2");
    const rev = r.service.rev();
    r.service.noteMarks();
    expect(r.service.rev()).not.toBe(rev);
    expect(served(r, ONE)?.hint).toBe(viewHint(BIN, T, ONE));

    // The new conversation proves itself in turn; then the harness changes.
    await r.service.start(T, ONE, { note: "Drawing", rules: ID });
    expect(served(r, ONE)?.hint).toBeUndefined();
    r.marks.set(ONE, "codex\u0000id:conv-2");
    // Serving reads the mark too, so a look between two sweeps is right.
    expect(served(r, ONE)?.hint).toBe(viewHint(BIN, T, ONE));

    // A pane gone (no mark) ends it as well.
    await r.service.start(T, ONE, { note: "Drawing", rules: ID });
    r.marks.set(ONE, null);
    r.service.noteMarks();
    expect(served(r, ONE)?.hint).toBe(viewHint(BIN, T, ONE));
  });

  test("a harness that reports no conversation keeps the proof while its harness stays", async () => {
    const r = handshake();
    await on(r, TWO);
    await r.service.start(T, TWO, { note: "Drawing", rules: ID });
    r.service.noteMarks();
    expect(served(r, TWO)?.hint).toBeUndefined();
  });

  test("a session whose head cannot name it keeps the tail, proof or not", async () => {
    const odd = "local/a'b#aaaa";
    const r = rig({ place: () => ({ address: odd }), sessionsKnown: () => false });
    await on(r, odd);
    await r.service.start(T, odd, { note: "Drawing", rules: ID });
    const session = r.service.status(T, odd);
    expect(session.head).toBe(viewHeadBare(T));
    expect(session.hint).toBe(viewHint(BIN, T, odd));
  });

  test("the socket's start fields carry the id; a value that is not text reads as none", () => {
    expect(readStartFields({ note: "x", rules: ID })).toEqual({ note: "x", rules: ID });
    expect(readStartFields({ note: "x" })).toEqual({ note: "x", rules: null });
    expect(readStartFields({ rules: 7 })).toEqual({ note: null, rules: null });
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
  test("sets the drawing and bumps the rev", async () => {
    const r = rig();
    await on(r, ONE);
    const rev = r.store.rev();
    const answer = await r.service.start(T, ONE, { note: "Checking the tests" });
    expect(answer.ok && answer.session).toMatchObject({ trick: T, session: ONE, on: true, drawing: { note: "Checking the tests" } });
    expect(r.store.rev()).toBeGreaterThan(rev!);
    await r.service.start(T, ONE, { note: "Still checking" });
    expect(r.service.status(T, ONE).drawing?.note).toBe("Still checking");
  });

  test("is refused while the person's switch is off, and nothing is stored", async () => {
    const r = rig();
    expect(await r.service.start(T, ONE, { note: "Checking" })).toEqual({ ok: false, error: VIEW_OFF_WORDS, code: "view_off" });
    expect(r.store.get(T, ONE)).toBeUndefined();
    expect(r.store.rev()).toBeUndefined();
    expect(r.service.status(T, ONE)).toEqual({ trick: T, session: ONE, on: false, off: "switch" });
  });

  test("a start with no note says only the time", async () => {
    const r = rig();
    await on(r, ONE);
    const answer = await r.service.start(T, ONE, { note: null });
    expect(answer.ok && answer.session.drawing?.note).toBeUndefined();
    expect(answer.ok && answer.session.drawing?.at).toBeDefined();
  });

  test("a note of two lines or past the cap is refused, and nothing is stored", async () => {
    const r = rig();
    await on(r, ONE);
    expect(await r.service.start(T, ONE, { note: "a\nb" })).toMatchObject({ ok: false, code: "bad_note" });
    expect(await r.service.start(T, ONE, { note: "x".repeat(VIEW_NOTE_MAX + 1) })).toMatchObject({ ok: false, code: "bad_note" });
    expect(r.service.status(T, ONE).drawing).toBeUndefined();
    expect(await r.service.start(T, ONE, { note: "x".repeat(VIEW_NOTE_MAX) })).toMatchObject({ ok: true });
    expect(r.store.get(T, TWO)).toBeUndefined();
  });

  test("a show, a clear and switching off end it; switching on keeps it", async () => {
    const r = rig();
    await on(r, ONE);
    await r.service.start(T, ONE, { note: "Drawing" });
    await on(r, ONE);
    expect(r.service.status(T, ONE).drawing).toBeDefined();
    await r.service.show(T, ONE, { view: goodView, title: null });
    expect(r.service.status(T, ONE).drawing).toBeUndefined();
    await r.service.start(T, ONE, { note: "Again" });
    await r.service.clear(T, ONE);
    expect(r.service.status(T, ONE).drawing).toBeUndefined();
    await r.service.start(T, ONE, { note: "Once more" });
    await r.service.switch({ trick: T, session: ONE, on: false }, null);
    expect(r.service.status(T, ONE).drawing).toBeUndefined();
  });

  test("a drawing older than ten minutes is not served, with no timer, and its view is then pruned at the next write", async () => {
    const r = rig();
    await on(r, ONE);
    await r.service.start(T, ONE, { note: "Drawing" });
    r.advance(VIEW_DRAWING_MAX_MS - 1000);
    expect(r.service.status(T, ONE).drawing).toBeDefined();
    r.advance(2000);
    expect(r.service.status(T, ONE).drawing).toBeUndefined();
    expect(r.service.answer().views[0]?.drawing).toBeUndefined();
    // Off with a stale drawing and nothing else: nothing left to say.
    await r.service.switch({ trick: T, session: ONE, on: false }, null);
    expect(r.service.answer().views).toEqual([]);
  });

  test("the drawing is held on the entry, as an optional field", async () => {
    const r = rig();
    await on(r, ONE);
    await r.service.start(T, ONE, { note: "Drawing" });
    const held = r.store.get(T, ONE);
    expect(held?.drawing?.note).toBe("Drawing");
    expect(Object.keys(JSON.parse(JSON.stringify(held)))).toContain("drawing");
  });

  test("a crew member refuses it", async () => {
    const r = rig();
    r.mode = "peer";
    expect(await r.service.start(T, ONE, { note: null })).toMatchObject({ ok: false, code: "not_on_lead" });
  });
});

describe("show and clear", () => {
  test("a show of a view that is on is stored, and its rev rises per view, also after a clear", async () => {
    const r = rig();
    await on(r, ONE);
    const first = await r.service.show(T, ONE, { view: goodView, title: "Tests" });
    expect(first.ok && first.session).toMatchObject({ trick: T, session: ONE, on: true, view: { rev: 1, title: "Tests" } });
    await r.service.clear(T, ONE);
    expect(r.service.status(T, ONE).view).toBeUndefined();
    const second = await r.service.show(T, ONE, { view: goodView, title: null });
    expect(second.ok && second.session.view?.rev).toBe(2);
    expect(second.ok && second.session.view?.title).toBeUndefined();
  });

  test("a show while the switch is off is refused view_off, and nothing is stored", async () => {
    const r = rig();
    const answer = await r.service.show(T, ONE, { view: goodView, title: null });
    expect(answer).toMatchObject({ ok: false, code: "view_off", error: VIEW_OFF_WORDS });
    expect(r.store.get(T, ONE)).toBeUndefined();
    expect(r.store.rev()).toBeUndefined();
  });

  test("a bad view is refused with the parser's path and reason, and nothing is stored", async () => {
    const r = rig();
    await on(r, ONE);
    const rev = r.store.rev();
    const answer = await r.service.show(T, ONE, { view: [{ kind: "bar", kids: [{ kind: "button", attrs: { label: "x" } }] }], title: null });
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.code).toBe("bad_view");
    expect(answer.error).toContain("/view/0/kids/0");
    expect(answer.refusals?.[0]?.path.startsWith("/view/0")).toBe(true);
    expect(r.service.status(T, ONE).view).toBeUndefined();
    expect(r.store.rev()).toBe(rev);
  });

  test("a title of two lines or past the cap is refused", async () => {
    const r = rig();
    await on(r, ONE);
    const answer = await r.service.show(T, ONE, { view: goodView, title: "a\nb" });
    expect(!answer.ok && answer.code).toBe("bad_title");
  });

  test("a crew member refuses every write", async () => {
    const r = rig();
    await on(r, ONE);
    r.mode = "peer";
    expect(await r.service.show(T, ONE, { view: goodView, title: null })).toMatchObject({ ok: false, code: "not_on_lead", error: VIEW_NOT_ON_LEAD });
    expect(await r.service.clear(T, ONE)).toMatchObject({ ok: false, code: "not_on_lead" });
    expect(await r.service.help(T, ONE)).toMatchObject({ ok: false, code: "not_on_lead" });
    expect(await r.service.switch({ trick: T, session: ONE, on: false }, null)).toMatchObject({ ok: false, status: 400, code: "not_on_lead" });
  });
});

describe("the gate, at every use", () => {
  test("a trick the bridge does not know, or that is off, refuses every write with the gate's code", async () => {
    const r = rig();
    await on(r, ONE);
    r.gates.set(T, { code: "trick_off" });
    expect(await r.service.show(T, ONE, { view: goodView, title: null })).toMatchObject({ ok: false, code: "trick_off" });
    expect(await r.service.start(T, ONE, { note: null })).toMatchObject({ ok: false, code: "trick_off" });
    expect(await r.service.clear(T, ONE)).toMatchObject({ ok: false, code: "trick_off" });
    r.gates.set(T, { code: "not_a_view" });
    expect(await r.service.set(T, ONE, { id: "a", node: { kind: "para", text: "x" }, place: { kind: "end" }, images: [] })).toMatchObject({ ok: false, code: "not_a_view" });
    r.gates.delete(T);
    expect(await r.service.keep(T, ONE, "all")).toMatchObject({ ok: false, code: "no_trick" });
  });

  test("a view whose trick is shut serves off, with the reason, no screen and no head, and its rev moves", async () => {
    const r = rig();
    await on(r, ONE);
    await r.service.show(T, ONE, { view: goodView, title: null });
    expect(served(r, ONE)?.view).toBeDefined();
    const rev = r.service.answer().rev;
    r.gates.set(T, { code: "trick_off" });
    const after = r.service.answer(rev);
    expect(after.views).toEqual([{ trick: T, session: ONE, on: false, off: "trick_off" }]);
    expect(after.rev).toBeGreaterThan(rev);
    // The switch is still on in the store: the trick coming back turns the view back on.
    expect(r.store.get(T, ONE)?.on).toBe(true);
    r.gates.set(T, { rules: RULES });
    expect(served(r, ONE)).toMatchObject({ on: true, view: { rev: 1 } });
  });

  test("switching on is refused when the gate fails, with the gate's code, a 409 and one audit line", async () => {
    const r = rig();
    r.gates.set(T, { code: "trick_off" });
    expect(await r.service.switch({ trick: T, session: ONE, on: true }, "phone")).toMatchObject({ ok: false, status: 409, code: "trick_off" });
    expect(r.store.get(T, ONE)).toBeUndefined();
    expect(r.audits).toEqual([{ action: "trick.view.refused", session: ONE, device: "phone", detail: { trick: T, reason: "trick_off", switch: true } }]);
  });

  test("switching off does not need the gate", async () => {
    const r = rig();
    await on(r, ONE);
    r.gates.delete(T);
    expect(await r.service.switch({ trick: T, session: ONE, on: false }, null)).toMatchObject({ ok: true, session: { on: false, off: "switch" } });
  });
});

describe("help", () => {
  test("goes to a view that is on and passes the gate, with the trick's approved rules and its id", async () => {
    const r = rig();
    await on(r, ONE);
    const answer = await r.service.help(T, ONE);
    expect(answer).toMatchObject({ ok: true, lines: ["help"], session: { trick: T, session: ONE, on: true } });
    expect(r.helpCalls).toEqual([{ binary: BIN, trick: T, name: "Morph", session: ONE, rules: RULES, rulesId: rulesIdOf(T, RULES) }]);
  });

  test("is refused to a session whose view is off, and to a trick the gate refuses", async () => {
    const r = rig();
    expect(await r.service.help(T, ONE)).toMatchObject({ ok: false, code: "view_off" });
    await on(r, ONE);
    r.gates.set(T, { code: "trick_off" });
    expect(await r.service.help(T, ONE)).toMatchObject({ ok: false, code: "trick_off" });
    expect(r.helpCalls).toEqual([]);
  });
});

describe("pruning", () => {
  test("a gone session is dropped at the next write, once sessions are listed", async () => {
    const r = rig();
    await on(r, ONE);
    await on(r, TWO);
    r.live.delete(ONE);
    await r.service.show(T, TWO, { view: goodView, title: null });
    expect(r.service.answer().views.map((s) => s.session)).toEqual([TWO]);
    expect(r.store.get(T, ONE)).toBeUndefined();
  });

  test("a bridge that lists no session yet forgets nothing", async () => {
    const r = rig();
    await on(r, ONE);
    await on(r, TWO);
    r.live.clear();
    await r.service.show(T, ONE, { view: goodView, title: null });
    expect(r.service.answer().views.map((s) => s.session)).toEqual([ONE, TWO]);
  });
});

describe("the phone's switch", () => {
  test("resolves the address to the live session and keys the view by that", async () => {
    const r = rig();
    const answer = await r.service.switch({ trick: T, session: "local/%1", on: true }, null);
    expect(answer).toMatchObject({ ok: true, session: { trick: T, session: ONE, on: true } });
    expect(r.service.status(T, ONE).on).toBe(true);
    expect(r.audits).toEqual([{ action: "trick.view.switch", session: ONE, device: null, detail: { trick: T, on: true } }]);
  });

  test("an address that names no live session here is a 404", async () => {
    const r = rig();
    expect(await r.service.switch({ trick: T, session: "local/%9#zzzz", on: true }, null)).toEqual({ ok: false, status: 404, error: VIEW_NO_SESSION, code: "wrong_session" });
  });

  test("off drops the screen and the drawing, and keeps the rev count, so a later show goes on from it", async () => {
    const r = rig();
    await on(r, ONE);
    await r.service.show(T, ONE, { view: goodView, title: null });
    await r.service.start(T, ONE, { note: "Drawing" });
    const off = await r.service.switch({ trick: T, session: ONE, on: false }, null);
    expect(off).toMatchObject({ ok: true, session: { on: false, off: "switch" } });
    expect(r.store.get(T, ONE)).toMatchObject({ on: false, shows: 1 });
    expect(r.store.get(T, ONE)?.view).toBeUndefined();
    await on(r, ONE);
    expect(r.service.status(T, ONE).view).toBeUndefined();
    const next = await r.service.show(T, ONE, { view: goodView, title: null });
    expect(next.ok && next.session.view?.rev).toBe(2);
  });

  test("on twice moves no screen: the held view and its count stay", async () => {
    const r = rig();
    await on(r, ONE);
    await r.service.show(T, ONE, { view: goodView, title: null });
    await on(r, ONE);
    expect(r.service.status(T, ONE).view?.rev).toBe(1);
  });

  test("a second trick's view of the same session goes off when the person switches the first on", async () => {
    const r = rig();
    await on(r, ONE, T);
    await r.service.show(T, ONE, { view: goodView, title: null });
    await on(r, TWO, T);
    // The same session, the other trick: the first view goes off with its screen; another session is not touched.
    const answer = await on(r, ONE, OTHER);
    expect(answer).toMatchObject({ trick: OTHER, session: ONE, on: true });
    expect(r.service.status(T, ONE)).toMatchObject({ on: false, off: "switch" });
    expect(r.service.status(T, ONE).view).toBeUndefined();
    expect(r.service.status(T, TWO).on).toBe(true);
    expect(await r.service.show(T, ONE, { view: goodView, title: null })).toMatchObject({ ok: false, code: "view_off" });
    expect(await r.service.show(OTHER, ONE, { view: goodView, title: null })).toMatchObject({ ok: true });
    // And back: the person turns the first trick on again, and the second goes off.
    await on(r, ONE, T);
    expect(r.service.status(OTHER, ONE).on).toBe(false);
    expect(r.service.status(T, ONE).on).toBe(true);
  });
});

describe("one view each, and the per-view read", () => {
  test("a write to one view leaves the entry of another untouched", async () => {
    const r = rig();
    await on(r, ONE);
    await on(r, TWO);
    await r.service.show(T, TWO, { view: goodView, title: "Two" });
    const two = r.store.get(T, TWO);
    const revTwo = r.store.revOf(T, TWO);
    await r.service.show(T, ONE, { view: goodView, title: "One" });
    expect(r.store.get(T, TWO)).toBe(two);
    expect(r.store.revOf(T, TWO)).toBe(revTwo);
    expect(r.store.revOf(T, ONE)).toBeGreaterThan(revTwo!);
  });

  test("without `since` every view is served and no keys; with an older one only the views that moved, and the keys of all", async () => {
    const r = rig();
    await on(r, ONE);
    await on(r, TWO);
    const full = r.service.answer();
    expect(full.views.map((s) => s.session)).toEqual([ONE, TWO]);
    expect(full.keys).toBeUndefined();
    expect(full.unchanged).toBeUndefined();

    await r.service.show(T, ONE, { view: goodView, title: null });
    const moved = r.service.answer(full.rev);
    expect(moved.views.map((s) => [s.trick, s.session])).toEqual([[T, ONE]]);
    expect(moved.keys).toEqual([
      { trick: T, session: ONE },
      { trick: T, session: TWO },
    ]);
    expect(moved.rev).toBeGreaterThan(full.rev);
  });

  test("a `since` equal to the rev answers the short form, one past it serves everything again", async () => {
    const r = rig();
    expect(r.service.answer()).toEqual({ rev: 0, views: [] });
    await on(r, ONE);
    const { rev } = r.service.answer();
    expect(r.service.answer(rev)).toEqual({ rev, unchanged: true, views: [] });
    const ahead = r.service.answer(rev + 1000);
    expect(ahead.views.map((s) => s.session)).toEqual([ONE]);
    expect(ahead.keys).toBeUndefined();
  });

  test("a view dropped shows in the keys of the next `since` read, so the phone forgets it", async () => {
    const r = rig();
    await on(r, ONE);
    await on(r, TWO);
    const { rev } = r.service.answer();
    await r.service.switch({ trick: T, session: TWO, on: false }, null);
    const next = r.service.answer(rev);
    expect(next.keys).toEqual([{ trick: T, session: ONE }]);
    expect(next.views).toEqual([]);
  });
});

describe("the routes", () => {
  test("GET /api/trick-views answers every view, the short form at the same rev, and 404 on a bridge without views", async () => {
    const r = rig();
    await on(r, ONE);
    const all = await (await trickViewsListRoute(r.service, null, null)).json();
    expect(all).toMatchObject({ views: [{ trick: T, session: ONE, on: true }] });
    expect(await (await trickViewsListRoute(r.service, String(all.rev), null)).json()).toEqual({ rev: all.rev, unchanged: true, views: [] });
    // A `since` that is no number reads as none: everything again.
    expect((await (await trickViewsListRoute(r.service, "x", null)).json()).views).toHaveLength(1);
    expect((await trickViewsListRoute(undefined, null, null)).status).toBe(404);
  });

  test("POST /api/trick-views/switch: 200 with the view, 400 for another body, 404 for no live session, 409 for a shut trick, 400 on a crew member", async () => {
    const r = rig();
    const ctx = { device: "Pixel 9", acceptEncoding: null };
    const ok = await trickViewsSwitchRoute(r.service, { trick: T, session: ONE, on: true }, ctx);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ trick: T, session: ONE, on: true });
    const bodies: (JsonValue | undefined)[] = [undefined, null, { session: ONE, on: true }, { trick: T, session: ONE, on: "yes" }, { trick: T, session: ONE, on: true, extra: 1 }, { trick: "../x", session: ONE, on: true }];
    for (const body of bodies) {
      expect((await trickViewsSwitchRoute(r.service, body, ctx)).status).toBe(400);
    }
    const gone = await trickViewsSwitchRoute(r.service, { trick: T, session: "local/%9", on: true }, ctx);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ code: "wrong_session", view: true });
    r.gates.set(OTHER, { code: "trick_off" });
    const shut = await trickViewsSwitchRoute(r.service, { trick: OTHER, session: ONE, on: true }, ctx);
    expect(shut.status).toBe(409);
    expect(await shut.json()).toMatchObject({ code: "trick_off", view: true });
    r.mode = "peer";
    expect((await trickViewsSwitchRoute(r.service, { trick: T, session: ONE, on: true }, ctx)).status).toBe(400);
  });
});
