import { describe, expect, test } from "bun:test";

import { HILL_ASK_CLEARED, type HillDecision } from "../../web/src/lib/hill/wire.ts";
import type { JsonObject } from "../json.ts";
import { parseJsonObject } from "../../web/src/lib/json.ts";
import { readWalkyRequest } from "../walky/parse.ts";
import { askInput, askRig, ONE, posted, uuid, type AskRig } from "./ask-rig.ts";
import { ASK_REMIND_CLEAR_WAIT_MS, ASK_REMIND_FULL_EVERY, AskRemindBook, remindKey, withoutHidden, type AskPane, type PaneAgentSession } from "./remind.ts";

// The reminder belongs to one agent session, not to the pane (the review of the Edge build, 2026-11-23):
// `ask.remind` lists and `/clear` closes only for the pane's current agent session as its hook edges name it;
// an ask is stamped with the session that posted it, and another conversation is not reminded of it; the
// full form comes back after 20 short ones; nothing hidden rides in the typed "Answers to your asks" text.

const P1: AskPane = { session: "main", paneId: "%1" };
const MARKERS = [{ namespace: "tmux", pane: "%1", scope: "/tmp/tmux-1/default" }];

interface Rig extends AskRig {
  readonly book: AskRemindBook;
  /** Set what the pane's hook edges name, or null when the bridge knows none. */
  readonly name: (session: PaneAgentSession | null) => void;
}

function rig(): Rig {
  let book: AskRemindBook | null = null;
  let named: PaneAgentSession | null = { current: "s1", previous: null };
  const r = askRig(undefined, (clock) => {
    book = new AskRemindBook(clock);
    return {
      reminders: book,
      paneAddress: (session, paneId) => (session === "main" && paneId === "%1" ? ONE.address : null),
      paneAgentSession: (session, paneId) => (session === "main" && paneId === "%1" ? named : null),
    };
  });
  return Object.assign(r, {
    book: book!,
    name: (session: PaneAgentSession | null) => {
      named = session;
    },
  });
}

/** An ask posted from the pane over the socket's path, so the bridge stamps it with the pane's session. */
async function postFromPane(r: Rig, n: number): Promise<HillDecision> {
  r.clock += 1000;
  const fields = parseJsonObject(JSON.stringify(askInput(n)));
  if (fields === undefined) throw new Error("the ask input is not an object");
  return posted(await r.hill.askPost(ONE, fields, P1));
}

/** An ask posted with no pane known (a build before the stamp, a lead's forwarded post): unstamped. */
function postUnstamped(r: Rig, n: number): HillDecision {
  r.clock += 1000;
  return posted(r.hill.post(ONE, askInput(n)));
}

function prompt(r: Rig, sessionId: string | null | undefined, hash = "h") {
  r.clock += 1000;
  return sessionId === undefined ? r.hill.askRemind(ONE, P1, { kind: "prompt", hash, at: r.clock }) : r.hill.askRemind(ONE, P1, { kind: "prompt", hash, at: r.clock, sessionId });
}

describe("one agent session: who gets the list", () => {
  test("the pane's session gets it; another id, no id on the call, or no id on the bridge gets none", async () => {
    const r = rig();
    const a = await postFromPane(r, 1);
    expect(prompt(r, "s1")).toMatchObject({ kind: "list", asks: [{ id: a.id }] });
    expect(prompt(r, "nested-claude-p")).toEqual({ kind: "none" });
    expect(prompt(r, null)).toEqual({ kind: "none" });
    expect(prompt(r, undefined)).toEqual({ kind: "none" });
    r.name(null);
    expect(prompt(r, "s1")).toEqual({ kind: "none" });
    for (const source of ["compact", "resume", "fork"]) expect(r.hill.askRemind(ONE, P1, { kind: "start", source, sessionId: "s1" })).toEqual({ kind: "none" });
  });

  test("a session start lists only for the pane's session", async () => {
    const r = rig();
    await postFromPane(r, 1);
    expect(r.hill.askRemind(ONE, P1, { kind: "start", source: "compact", sessionId: "other" })).toEqual({ kind: "none" });
    expect(r.hill.askRemind(ONE, P1, { kind: "start", source: "compact", sessionId: "s1" })).toMatchObject({ kind: "list", form: "full" });
  });

  test("a changed conversation (resume or fork): the earlier one's asks are not listed; an unstamped ask still is", async () => {
    const r = rig();
    const mine = await postFromPane(r, 1);
    const old = postUnstamped(r, 2);
    expect(r.book.stampOf(mine.id)).toBe("s1");
    expect(r.book.stampOf(old.id)).toBeUndefined();
    // The same process resumed another conversation: its edges name s9 now.
    r.name({ current: "s9", previous: "s1" });
    expect(r.hill.askRemind(ONE, P1, { kind: "start", source: "resume", sessionId: "s9" })).toEqual({ kind: "list", form: "full", asks: [{ id: old.id, title: old.title }] });
    const listed = prompt(r, "s9");
    expect(listed).toMatchObject({ kind: "list", asks: [{ id: old.id }] });
    expect(JSON.stringify(listed)).not.toContain(mine.id);
    // Back in the first conversation, its own ask is listed again.
    r.name({ current: "s1", previous: "s9" });
    const back = prompt(r, "s1");
    expect(back.kind === "list" && back.asks.map((ask) => ask.id)).toEqual([mine.id, old.id]);
  });

  test("an ask of another conversation reads unchecked on the next prompt edge and is never carried", async () => {
    const r = rig();
    const mine = await postFromPane(r, 1);
    r.name({ current: "s9", previous: "s1" });
    expect(prompt(r, "s9", "h9")).toEqual({ kind: "none" });
    r.hill.askEdge(P1, "prompt", r.clock, "h9");
    r.hill.askEdge(P1, "stop", r.clock + 10, null);
    expect(r.store.get(mine.id)?.ask?.mark).toBe("unchecked");
  });
});

describe("one agent session: the /clear rule", () => {
  test("a clear whose id the pane's edges never name closes nothing (a second process in the pane)", async () => {
    const r = rig();
    const a = await postFromPane(r, 1);
    r.hill.askRemind(ONE, P1, { kind: "start", source: "clear", sessionId: "nested" });
    r.hill.askEdge(P1, "start", r.clock, null);
    r.hill.askEdge(P1, "prompt", r.clock + 1, null);
    expect(r.store.get(a.id)?.state).toBe("open");
    // A clear with no id at all closes nothing either.
    r.hill.askRemind(ONE, P1, { kind: "start", source: "clear", sessionId: null });
    r.name({ current: "s2", previous: "s1" });
    r.hill.askEdge(P1, "start", r.clock, null);
    expect(r.store.get(a.id)?.state).toBe("open");
  });

  test("the pane's own clear: applies on the start edge that names the new id, moved to from the cleared one", async () => {
    const r = rig();
    const a = await postFromPane(r, 1);
    r.hill.askRemind(ONE, P1, { kind: "start", source: "clear", sessionId: "s2" });
    // The start edge is not in yet: nothing closed.
    expect(r.store.get(a.id)?.state).toBe("open");
    r.name({ current: "s2", previous: "s1" });
    r.hill.askEdge(P1, "start", r.clock, null);
    expect(r.store.get(a.id)).toMatchObject({ state: "withdrawn", closedReason: HILL_ASK_CLEARED });
  });

  test("the edge came first: the call that names the pane's current session closes the asks of the one before", async () => {
    const r = rig();
    const a = await postFromPane(r, 1);
    r.name({ current: "s2", previous: "s1" });
    r.hill.askRemind(ONE, P1, { kind: "start", source: "clear", sessionId: "s2" });
    expect(r.store.get(a.id)?.closedReason).toBe(HILL_ASK_CLEARED);
  });

  test("an ask another conversation posted is not closed by this one's clear; an unstamped one is", async () => {
    const r = rig();
    const mine = await postFromPane(r, 1);
    const old = postUnstamped(r, 2);
    // An open ask of the same pane address that conversation s0 posted earlier.
    const foreign: HillDecision = { ...mine, id: "ak_other0000001", requestId: uuid(77) };
    r.store.put(foreign);
    r.book.stamp(foreign.id, "s0");
    r.hill.askRemind(ONE, P1, { kind: "start", source: "clear", sessionId: "s2" });
    r.name({ current: "s2", previous: "s1" });
    r.hill.askEdge(P1, "start", r.clock, null);
    expect(r.store.get(mine.id)?.closedReason).toBe(HILL_ASK_CLEARED);
    expect(r.store.get(old.id)?.closedReason).toBe(HILL_ASK_CLEARED);
    expect(r.store.get(foreign.id)?.state).toBe("open");
  });

  test("the edges named another previous session than the call knew: nothing closes", async () => {
    const r = rig();
    const a = await postFromPane(r, 1);
    r.hill.askRemind(ONE, P1, { kind: "start", source: "clear", sessionId: "s2" });
    r.name({ current: "s2", previous: "sX" });
    r.hill.askEdge(P1, "start", r.clock, null);
    expect(r.store.get(a.id)?.state).toBe("open");
  });

  test("a clear waits at most its window for the edges", async () => {
    const r = rig();
    const a = await postFromPane(r, 1);
    r.hill.askRemind(ONE, P1, { kind: "start", source: "clear", sessionId: "s2" });
    r.clock += ASK_REMIND_CLEAR_WAIT_MS + 1;
    r.name({ current: "s2", previous: "s1" });
    r.hill.askEdge(P1, "start", r.clock, null);
    expect(r.store.get(a.id)?.state).toBe("open");
  });
});

describe("the full form after 20 short ones", () => {
  test("1 full, 20 short, then full again, and the count starts over", async () => {
    const r = rig();
    await postFromPane(r, 1);
    expect(prompt(r, "s1", "h0")).toMatchObject({ form: "full" });
    for (let n = 1; n <= ASK_REMIND_FULL_EVERY; n += 1) expect(prompt(r, "s1", `h${String(n)}`)).toMatchObject({ form: "short" });
    expect(prompt(r, "s1", "hx")).toMatchObject({ form: "full" });
    expect(prompt(r, "s1", "hy")).toMatchObject({ form: "short" });
  });

  test("the book: forget and a new full form reset the count; each session counts apart", () => {
    const book = new AskRemindBook(() => 1);
    const key = remindKey("local/%1#aaaa", "s1");
    expect(book.form(key, ["ak_a"])).toBe("full");
    for (let n = 0; n < 5; n += 1) expect(book.form(key, ["ak_a"])).toBe("short");
    book.forget(key);
    expect(book.form(key, ["ak_a"])).toBe("full");
    for (let n = 0; n < ASK_REMIND_FULL_EVERY - 1; n += 1) book.form(key, ["ak_a"]);
    // A new ask: full, and the count starts over.
    expect(book.form(key, ["ak_a", "ak_b"])).toBe("full");
    for (let n = 0; n < ASK_REMIND_FULL_EVERY; n += 1) expect(book.form(key, ["ak_a", "ak_b"])).toBe("short");
    expect(book.form(key, ["ak_a", "ak_b"])).toBe("full");
    // Another conversation of the same address has its own set: its first list is full.
    expect(book.form(remindKey("local/%1#aaaa", "s2"), ["ak_a", "ak_b"])).toBe("full");
  });
});

describe("hidden characters", () => {
  test("withoutHidden drops Cf and the tag block, and turns Cc, Zl and Zp into spaces", () => {
    expect(withoutHidden("a​b⁠c﻿d")).toBe("abcd");
    expect(withoutHidden("x\u{E0041}\u{E0001}\u{E007F}y")).toBe("xy");
    expect(withoutHidden("a‮b⁦c­d")).toBe("abcd");
    expect(withoutHidden("a\u0007b c d\ne")).toBe("a b c d e");
    expect(withoutHidden("plain words, été \u{1F600}")).toBe("plain words, été \u{1F600}");
  });

  test("the typed Answers message carries no hidden character of the question or a label", async () => {
    const r = askRig();
    const title = "Ship\u{E0041}\u{E0049} it⁡ now?";
    const a = posted(
    r.hill.post(
      ONE,
      askInput(1, {
        title,
        options: [
          { intent: "edge", label: "Edge\u{E0020}first", detail: "x" },
          { intent: "stable", label: "Stable", detail: "y" },
        ],
      }),
    ),
  );
    await r.hill.answerAsks({ rid: uuid(90), answers: [{ id: a.id, intent: "edge", text: null }] }, "Pixel 9");
    expect(r.sent).toHaveLength(1);
    const body = r.sent[0]!.body;
    expect(body).toContain('"Ship it now?": edge (Edgefirst)');
    expect(body).not.toMatch(/[\p{Cf}\u{E0000}-\u{E007F}]/u);
  });
});

describe("the wire: an optional sessionId on ask.remind", () => {
  test("read when it has the shape; absent or malformed reads as none, never a refusal", () => {
    const base = { v: 1, markers: MARKERS, op: "ask.remind", event: "prompt", promptHash: "ab", at: 5 };
    const read = (extra: JsonObject) => readWalkyRequest(JSON.stringify({ ...base, ...extra }));
    expect(read({ sessionId: "0a1b-2c3d" })).toMatchObject({ ok: true, request: { event: { sessionId: "0a1b-2c3d" } } });
    for (const sessionId of [undefined, null, "", "../x", "a b", 5, "x".repeat(200)]) expect(read({ sessionId })).toMatchObject({ ok: true, request: { event: { sessionId: null } } });
    expect(readWalkyRequest(JSON.stringify({ ...base, event: "start", source: "clear", sessionId: "s2" }))).toMatchObject({ ok: true, request: { event: { kind: "start", sessionId: "s2" } } });
  });
});
