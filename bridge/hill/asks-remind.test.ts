import { describe, expect, test } from "bun:test";

import { HILL_ASK_CLEARED, type HillDecision } from "../../web/src/lib/hill/wire.ts";
import { askInput, askRig, ONE, posted, TWO, type AskRig } from "./ask-rig.ts";
import { AskRemindBook, type PaneAgentSession } from "./remind.ts";
import type { HillAgentSender } from "./service.ts";

// The reminder that rides on the prompt, in the service (.adr/0178): `ask.remind` for a prompt and for a
// session start, the bridge's own "Answers to your asks" prompt, the short form, the /clear rule, a crew
// member, and the marks (fresh, carried, unchecked) through a sequence of hook edges.

const P1 = { session: "main", paneId: "%1" };
const P2 = { session: "main", paneId: "%2" };

interface Rig extends AskRig {
  readonly book: AskRemindBook;
  /** The agent session each pane's hook edges name (2026-11-23): `s1` on both panes until a test moves it. */
  readonly sessions: Map<string, PaneAgentSession>;
}

function rig(over: { crewMode?: "solo" | "peer" } = {}): Rig {
  let book: AskRemindBook | null = null;
  const sessions = new Map<string, PaneAgentSession>([
    ["%1", { current: "s1", previous: null }],
    ["%2", { current: "s1", previous: null }],
  ]);
  const r = askRig(undefined, (clock) => {
    book = new AskRemindBook(clock);
    const paneAddress = (session: string, paneId: string): string | null => (session !== "main" ? null : paneId === "%1" ? ONE.address : paneId === "%2" ? TWO.address : null);
    const paneAgentSession = (session: string, paneId: string): PaneAgentSession | null => (session === "main" ? (sessions.get(paneId) ?? null) : null);
    const crewMode = over.crewMode;
    if (crewMode === undefined) return { reminders: book, paneAddress, paneAgentSession };
    return { reminders: book, paneAddress, paneAgentSession, crewMode: () => crewMode };
  });
  return Object.assign(r, { book: book!, sessions });
}

/** `/clear` in pane P1: the hook's call names the new conversation, then the pane's own start edge names it too. */
function clear(r: Rig): void {
  r.hill.askRemind(ONE, P1, { kind: "start", source: "clear", sessionId: "s2" });
  r.sessions.set("%1", { current: "s2", previous: "s1" });
  r.hill.askEdge(P1, "start", r.clock, null);
}

function post(r: Rig, n: number, from: HillAgentSender = ONE): HillDecision {
  r.clock += 1000;
  return posted(r.hill.post(from, askInput(n)));
}

function prompt(r: Rig, hash: string | null = "h", where = P1, from: HillAgentSender = ONE) {
  r.clock += 1000;
  return r.hill.askRemind(from, where, { kind: "prompt", hash, at: r.clock, sessionId: "s1" });
}

function mark(r: Rig, id: string) {
  const ask = r.store.get(id)?.ask;
  return { mark: ask?.mark, confirmedAt: ask?.confirmedAt };
}

describe("ask.remind for a prompt", () => {
  test("lists the asks posted before this prompt, not one posted after", () => {
    const r = rig();
    const a = post(r, 1);
    const b = post(r, 2);
    const at = r.clock + 1;
    r.clock += 5000;
    const late = posted(r.hill.post(ONE, askInput(3)));
    const answer = r.hill.askRemind(ONE, P1, { kind: "prompt", hash: "h", at, sessionId: "s1" });
    expect(answer).toEqual({ kind: "list", form: "full", asks: [{ id: a.id, title: a.title }, { id: b.id, title: b.title }] });
    expect(JSON.stringify(answer)).not.toContain(late.id);
  });

  test("none with no open asks, and none for another session's asks", () => {
    const r = rig();
    expect(prompt(r)).toEqual({ kind: "none" });
    post(r, 1, TWO);
    expect(prompt(r)).toEqual({ kind: "none" });
  });

  test("the same set again is the short form; a new ask makes it full once, then short again", () => {
    const r = rig();
    const a = post(r, 1);
    expect(prompt(r, "h1")).toMatchObject({ kind: "list", form: "full" });
    expect(prompt(r, "h2")).toMatchObject({ kind: "list", form: "short", asks: [{ id: a.id }] });
    post(r, 2);
    expect(prompt(r, "h3")).toMatchObject({ kind: "list", form: "full" });
    expect(prompt(r, "h4")).toMatchObject({ kind: "list", form: "short" });
  });

  test("two asks, full; one is taken back; the next prompt is short with one id", () => {
    const r = rig();
    const a = post(r, 1);
    const b = post(r, 2);
    expect(prompt(r, "h1")).toMatchObject({ kind: "list", form: "full", asks: [{ id: a.id }, { id: b.id }] });
    r.hill.cancelAsk(ONE, b.id, { answered: true, because: null });
    expect(prompt(r, "h2")).toMatchObject({ kind: "list", form: "short", asks: [{ id: a.id }] });
    expect(prompt(r, "h3")).toMatchObject({ kind: "list", form: "short", asks: [{ id: a.id }] });
  });

  test("at most 5 asks are listed, oldest first", () => {
    const r = rig();
    const six: HillDecision[] = [];
    for (let n = 1; n <= 5; n += 1) six.push(post(r, n));
    // A sixth open ask of the session, as an older bridge or a member's lead could hold it.
    const extra = { ...six[0]!, id: "ak_extra0000006", requestId: "00000000-0000-4000-8000-000000000066", at: r.clock + 10 };
    r.store.put(extra);
    r.clock += 100;
    const answer = r.hill.askRemind(ONE, P1, { kind: "prompt", hash: "h", at: r.clock, sessionId: "s1" });
    expect(answer.kind === "list" && answer.asks.map((ask) => ask.id)).toEqual(six.map((ask) => ask.id));
  });

  test("the bridge's own Answers prompt (its hash is one the bridge typed into this pane) is none", () => {
    const r = rig();
    post(r, 1);
    r.hill.typedAnswers(P1, "own-hash", r.clock);
    expect(prompt(r, "own-hash")).toEqual({ kind: "none" });
    // Once: the same text typed by a person later is a prompt like any other.
    expect(prompt(r, "own-hash")).toMatchObject({ kind: "list" });
    // Typed into another pane, it is not this pane's own prompt.
    r.hill.typedAnswers(P2, "other-hash", r.clock);
    expect(prompt(r, "other-hash")).toMatchObject({ kind: "list" });
  });

  test("a hook clock far from the bridge's is not believed: the bridge's own time decides", () => {
    const r = rig();
    r.clock = 50_000_000;
    const a = post(r, 1);
    r.clock += 1000;
    // An hour before the post by the hook's clock: believed, it would list nothing.
    const answer = r.hill.askRemind(ONE, P1, { kind: "prompt", hash: "h", at: r.clock - 3_600_000, sessionId: "s1" });
    expect(answer).toMatchObject({ kind: "list", asks: [{ id: a.id }] });
  });

  test("a crew member answers none: the lead holds the asks", () => {
    const r = rig({ crewMode: "peer" });
    expect(r.hill.askRemind(ONE, P1, { kind: "prompt", hash: "h", at: r.clock, sessionId: "s1" })).toEqual({ kind: "none" });
  });

  test("on the lead, an ask a crew member forwarded is unchecked from its post, never fresh or carried", () => {
    const r = rig();
    const member: HillAgentSender = { ...ONE, address: "m_bbbbbbbbbb/%9#cccc", memberId: "m_bbbbbbbbbb" };
    r.live.add(member.address);
    const ask = post(r, 1, member);
    expect(mark(r, ask.id).mark).toBe("unchecked");
  });
});

describe("ask.remind for a session start", () => {
  test("compact, resume and fork give the full list; startup and anything else give nothing", () => {
    const r = rig();
    const a = post(r, 1);
    prompt(r, "h1");
    for (const source of ["compact", "resume", "fork"]) expect(r.hill.askRemind(ONE, P1, { kind: "start", source, sessionId: "s1" })).toEqual({ kind: "list", form: "full", asks: [{ id: a.id, title: a.title }] });
    for (const source of ["startup", "Compact", "", "clear "]) expect(r.hill.askRemind(ONE, P1, { kind: "start", source, sessionId: "s1" })).toEqual({ kind: "none" });
    expect(r.store.get(a.id)?.state).toBe("open");
  });
});

describe("the /clear rule", () => {
  test("closes the pane's own open asks as conversation cleared, kept in the closed list", () => {
    const r = rig();
    const a = post(r, 1);
    const b = post(r, 2);
    expect(r.hill.askRemind(ONE, P1, { kind: "start", source: "clear", sessionId: "s2" })).toEqual({ kind: "none" });
    r.sessions.set("%1", { current: "s2", previous: "s1" });
    r.hill.askEdge(P1, "start", r.clock, null);
    for (const id of [a.id, b.id]) expect(r.store.get(id)).toMatchObject({ state: "withdrawn", closedReason: HILL_ASK_CLEARED });
    expect(r.hill.list().closed.map((decision) => decision.id).toSorted()).toEqual([a.id, b.id].toSorted());
  });

  test("does not touch another pane's asks, nor another session in the same pane id, nor another machine's pane", () => {
    const r = rig();
    const two = post(r, 1, TWO);
    const sameIdNewSession: HillAgentSender = { ...ONE, address: "local/%1#zzzz" };
    r.live.add(sameIdNewSession.address);
    const old = post(r, 2, sameIdNewSession);
    const elsewhere: HillAgentSender = { ...ONE, address: "m_bbbbbbbbbb/%1#aaaa", memberId: "m_bbbbbbbbbb" };
    r.live.add(elsewhere.address);
    const far = post(r, 3, elsewhere);
    clear(r);
    for (const id of [two.id, old.id, far.id]) expect(r.store.get(id)?.state).toBe("open");
  });

  test("does not touch a closed ask, and nothing at all when the source is not exactly clear", () => {
    const r = rig();
    const a = post(r, 1);
    const b = post(r, 2);
    r.hill.cancelAsk(ONE, b.id, { answered: true, because: null });
    for (const source of ["Clear", "clear\n", "cleared", "compact"]) r.hill.askRemind(ONE, P1, { kind: "start", source, sessionId: "s1" });
    expect(r.store.get(a.id)?.state).toBe("open");
    clear(r);
    expect(r.store.get(a.id)?.closedReason).toBe(HILL_ASK_CLEARED);
    expect(r.store.get(b.id)?.closedReason).toBe("answered in the session");
  });

  test("a prompt event never clears; a member clears nothing", () => {
    const r = rig();
    const a = post(r, 1);
    prompt(r);
    expect(r.store.get(a.id)?.state).toBe("open");
    const m = rig({ crewMode: "peer" });
    expect(m.hill.askRemind(ONE, P1, { kind: "start", source: "clear", sessionId: "s2" })).toEqual({ kind: "none" });
    m.sessions.set("%1", { current: "s2", previous: "s1" });
    m.hill.askEdge(P1, "start", m.clock, null);
  });
});

describe("the marks through the edges", () => {
  test("post: fresh; prompt with a hand-out: unchecked while the turn runs; its stop: carried with confirmedAt", () => {
    const r = rig();
    const a = post(r, 1);
    expect(mark(r, a.id)).toEqual({ mark: "fresh", confirmedAt: undefined });
    const answer = prompt(r, "h1");
    expect(answer.kind).toBe("list");
    r.hill.askEdge(P1, "prompt", r.clock + 2, "h1");
    expect(mark(r, a.id).mark).toBe("unchecked");
    r.hill.askEdge(P1, "stop", r.clock + 4000, null);
    expect(mark(r, a.id)).toEqual({ mark: "carried", confirmedAt: r.clock + 4000 });
  });

  test("a prompt with no hand-out makes it unchecked until a later turn carries it", () => {
    const r = rig();
    const a = post(r, 1);
    prompt(r, "h1");
    r.hill.askEdge(P1, "prompt", r.clock, "h1");
    r.hill.askEdge(P1, "stop", r.clock + 10, null);
    expect(mark(r, a.id).mark).toBe("carried");
    // No hook ran for this prompt (a fault, no reminder installed).
    r.clock += 1000;
    r.hill.askEdge(P1, "prompt", r.clock, "h2");
    expect(mark(r, a.id).mark).toBe("unchecked");
    r.hill.askEdge(P1, "stop", r.clock + 10, null);
    expect(mark(r, a.id).mark).toBe("unchecked");
    // The next turn hands it out and ends: carried again.
    prompt(r, "h3");
    r.hill.askEdge(P1, "prompt", r.clock, "h3");
    r.hill.askEdge(P1, "stop", r.clock + 10, null);
    expect(mark(r, a.id)).toEqual({ mark: "carried", confirmedAt: r.clock + 10 });
  });

  test("Escape sends no stop: the ask stays unchecked", () => {
    const r = rig();
    const a = post(r, 1);
    prompt(r, "h1");
    r.hill.askEdge(P1, "prompt", r.clock, "h1");
    expect(mark(r, a.id).mark).toBe("unchecked");
    expect(mark(r, a.id).confirmedAt).toBeUndefined();
  });

  test("an ask posted during the turn stays fresh at its stop; a closed ask is not marked", () => {
    const r = rig();
    const a = post(r, 1);
    prompt(r, "h1");
    r.hill.askEdge(P1, "prompt", r.clock, "h1");
    const during = post(r, 2);
    r.hill.cancelAsk(ONE, a.id, { answered: true, because: null });
    r.hill.askEdge(P1, "stop", r.clock + 10, null);
    expect(mark(r, during.id).mark).toBe("fresh");
    expect(r.store.get(a.id)?.ask?.mark).toBe("unchecked");
  });

  test("a restart forgets the turn: the stop then marks nothing, and the next turn starts again", () => {
    const r = rig();
    const a = post(r, 1);
    prompt(r, "h1");
    r.hill.askEdge(P1, "prompt", r.clock, "h1");
    // A new book, as after a restart; the stored mark stays.
    const fresh = new AskRemindBook(() => r.clock);
    const again = askRig(undefined, () => ({ reminders: fresh, paneAddress: () => ONE.address }));
    again.store.put(r.store.get(a.id)!);
    again.hill.askEdge(P1, "stop", r.clock + 10, null);
    expect(again.store.get(a.id)?.ask?.mark).toBe("unchecked");
  });

  test("another pane's edges move nothing of this session; a subagent never reaches here (the router keeps it out)", () => {
    const r = rig();
    const a = post(r, 1);
    r.clock += 1000;
    r.hill.askEdge(P2, "prompt", r.clock, "x");
    expect(mark(r, a.id).mark).toBe("fresh");
  });

  test("a turn without a reminder (Codex, no hooks) never reads carried", () => {
    const r = rig();
    const a = post(r, 1);
    r.clock += 1000;
    r.hill.askEdge(P1, "prompt", r.clock, null);
    r.hill.askEdge(P1, "stop", r.clock + 10, null);
    expect(mark(r, a.id).mark).toBe("unchecked");
  });
});
