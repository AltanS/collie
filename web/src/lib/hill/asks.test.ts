import { describe, expect, it } from "vitest";

import { hillDecision, HILL_T0 } from "@/test/hill-fixtures";
import type { AgentView } from "../types";
import type { WalkyLivePanes } from "../walky-names";
import {
  askFileRequest,
  cacheOf,
  closedAskWhy,
  foldsOf,
  groupAsks,
  markedAnswer,
  markedAnswersOf,
  mayOpenFile,
  nextAsk,
  openAsksOf,
  openCardsOf,
  orderSessions,
  positionOf,
  reviewOf,
  sessionFacts,
  sessionKeyOf,
  sessionOpenPath,
  wordsPreview,
  type AskDecision,
  type AskDraft,
} from "./asks";
import { HILL_MORE_CONTEXT, type HillAsk, type HillDecision } from "./wire";

// The pure rules the Asks pages share (lib/hill/asks.ts): grouping, order, header facts, place among a session's
// asks, the review's exact message, the folds of one Send, and the Files request of a linked file.

function pane(over: Partial<AgentView> = {}): AgentView {
  return {
    paneId: "w6:p3",
    workspaceId: "w6",
    workspaceLabel: "collie-workspace",
    workspaceNumber: 6,
    tabId: "w6:t1",
    tabLabel: "build",
    agent: "claude",
    status: "idle",
    cwd: "/home/dev/collie",
    focused: false,
    kind: "agent",
    host: "lodge",
    ...over,
  };
}

const live = (panes: AgentView[]): WalkyLivePanes => ({ panes, lead: "lodge" });

let n = 0;
function ask(over: Partial<HillDecision> = {}, askOver: Partial<HillAsk> = {}, address = "lodge/w6:p3#tok1"): AskDecision {
  n += 1;
  const base = hillDecision({
    id: `ak_${String(n).padStart(12, "0")}`,
    title: `Question ${n}?`,
    from: { kind: "agent", address, trickId: null, trickKey: null, memberId: null, harness: "claude", label: "agent one", host: "lodge", trickHost: null },
    options: [
      { intent: "yes", label: "Yes" },
      { intent: "no", label: "No" },
    ],
    at: HILL_T0 + n * 1000,
    ...over,
  });
  return { ...base, ask: { words: false, files: [], root: "w6:p3", ...askOver } };
}

describe("openAsksOf and openCardsOf", () => {
  it("split the open list into asks and the Decisions that are not asks, each in the list's order", () => {
    const a = ask();
    const card = hillDecision({ title: "A trick card" });
    const b = ask();
    expect(openAsksOf([a, card, b]).map((d) => d.id)).toEqual([a.id, b.id]);
    expect(openCardsOf([a, card, b])).toEqual([card]);
  });
});

describe("groupAsks", () => {
  it("groups by the sender's address, each group oldest first", () => {
    const a1 = ask({ at: HILL_T0 + 5 });
    const b1 = ask({ at: HILL_T0 + 1 }, {}, "lodge/w7:p1#tok2");
    const a2 = ask({ at: HILL_T0 + 2 });
    const groups = groupAsks([a1, b1, a2]);
    expect(groups.map((g) => [g.key, g.asks.map((d) => d.id)])).toEqual([
      ["lodge/w7:p1#tok2", [b1.id]],
      ["lodge/w6:p3#tok1", [a2.id, a1.id]],
    ]);
    expect(groups[1]?.newest).toBe(HILL_T0 + 5);
    expect(sessionKeyOf(a1)).toBe("lodge/w6:p3#tok1");
  });
});

describe("orderSessions", () => {
  it("puts the session worked with last first, and a session Collie no longer lists by its newest ask", () => {
    const here = ask({ at: HILL_T0 + 10 });
    const other = ask({ at: HILL_T0 + 20 }, {}, "lodge/w9:p1#tok3");
    const gone = ask({ at: HILL_T0 + 15 }, {}, "lodge/w5:p5#tok4");
    const groups = groupAsks([here, other, gone]);
    const panes = live([pane({ lastActiveAt: HILL_T0 + 900 }), pane({ paneId: "w9:p1", lastActiveAt: HILL_T0 + 100 })]);
    expect(orderSessions(groups, panes).map((g) => g.key)).toEqual(["lodge/w6:p3#tok1", "lodge/w9:p1#tok3", "lodge/w5:p5#tok4"].toSorted((a, b) => (a === "lodge/w6:p3#tok1" ? -1 : b === "lodge/w6:p3#tok1" ? 1 : 0)));
  });

  it("keeps the order a page drew before, and puts a new session on top", () => {
    const a = ask({ at: HILL_T0 + 1 });
    const b = ask({ at: HILL_T0 + 2 }, {}, "lodge/w7:p1#tok2");
    const first = orderSessions(groupAsks([a, b]), live([])).map((g) => g.key);
    expect(first).toEqual(["lodge/w7:p1#tok2", "lodge/w6:p3#tok1"]);
    const c = ask({ at: HILL_T0 + 3 }, {}, "lodge/w8:p1#tok5");
    const again = orderSessions(groupAsks([a, b, c]), live([]), first.toReversed()).map((g) => g.key);
    expect(again).toEqual(["lodge/w8:p1#tok5", "lodge/w6:p3#tok1", "lodge/w7:p1#tok2"]);
  });
});

describe("sessionFacts", () => {
  it("names the session as the Dashboard does, says what it works on, its state and how to open it", () => {
    const p = pane({ status: "working", paneLabel: "release lane", gitHead: { kind: "branch", name: "main" } });
    const facts = sessionFacts({ key: "lodge/w6:p3#tok1", label: "agent one" }, live([p]));
    expect(facts).toMatchObject({ name: "release lane", gone: false, status: "working", stateWord: "working" });
    expect(facts.line).toContain("collie-workspace");
    expect(facts.line).toContain("main");
    // The pane's own host rides the address; with no server list the lead is not known, so nothing is normalised away.
    expect(sessionOpenPath(p, {}, undefined)).toBe("/pane/w6%3Ap3?h=lodge");
  });

  it("is gone with the sender's own label and no way to open it when no live pane holds the address", () => {
    expect(sessionFacts({ key: "lodge/w6:p3#tok1", label: "agent one" }, live([]))).toEqual({ name: "agent one", line: null, status: null, stateWord: null, gone: true, pane: null });
    // A pane id handed to another instance is no live pane.
    expect(sessionFacts({ key: "lodge/w6:p3#tok1", label: "agent one" }, live([pane({ instance: "other" })])).gone).toBe(true);
  });
});

describe("cacheOf", () => {
  const NOW = 1_000_000;
  const cache = (over: Partial<NonNullable<AgentView["cache"]>>): NonNullable<AgentView["cache"]> => ({ state: "warm", ttlSeconds: 300, ruleId: "r", confidence: "documented", ...over });
  it("reads warm with the time left, expiring as warm, cold, and everything else as unknown", () => {
    expect(cacheOf(pane({ cache: cache({ expiresAt: NOW + 120_000 }) }), NOW)).toEqual({ state: "warm", msLeft: 120_000 });
    expect(cacheOf(pane({ cache: cache({ state: "expiring", expiresAt: NOW + 30_000 }) }), NOW)).toEqual({ state: "warm", msLeft: 30_000 });
    expect(cacheOf(pane({ cache: cache({ state: "cold" }) }), NOW)).toEqual({ state: "cold" });
    expect(cacheOf(pane({ cache: cache({ expiresAt: NOW - 60_000 }) }), NOW)).toEqual({ state: "cold" });
    expect(cacheOf(pane({ cache: cache({ state: "unknown" }) }), NOW)).toEqual({ state: "unknown" });
    expect(cacheOf(pane({}), NOW)).toEqual({ state: "unknown" });
    expect(cacheOf(null, NOW)).toEqual({ state: "unknown" });
  });
});

describe("positionOf and nextAsk", () => {
  const list = [ask(), ask(), ask()];
  it("says where an ask sits among its session's open asks, and which comes after it", () => {
    expect(positionOf(list, list[1]!.id)).toEqual({ index: 2, count: 3 });
    expect(positionOf(list, "ak_missing00000")).toBeNull();
    expect(nextAsk(list, list[0]!.id)).toBe(list[1]);
    expect(nextAsk(list, list[2]!.id)).toBeNull();
    expect(nextAsk(list, "ak_missing00000")).toBeNull();
  });
});

describe("markedAnswer", () => {
  const a = ask({ recommends: { intent: "yes", why: "safe" } });
  const words = ask({}, { words: true });
  it("counts a marked option, with its note", () => {
    expect(markedAnswer(a, { intent: "no", text: " later " })).toMatchObject({ intent: "no", text: "later" });
    expect(markedAnswer(a, { intent: HILL_MORE_CONTEXT, text: "" })).toMatchObject({ intent: HILL_MORE_CONTEXT, text: null });
  });
  it("counts no answer for a note alone, an option the ask no longer has, or an empty words field", () => {
    expect(markedAnswer(a, { intent: null, text: "note" })).toBeNull();
    expect(markedAnswer(a, { intent: "maybe", text: "" })).toBeNull();
    expect(markedAnswer(words, { intent: null, text: "  " })).toBeNull();
  });
  it("takes the words of a words ask as the answer", () => {
    expect(markedAnswer(words, { intent: null, text: "ship it today" })).toMatchObject({ intent: "answer", text: "ship it today" });
  });
  it("shortens words for a row", () => {
    expect(wordsPreview("one two three four five six seven")).toBe("one two three four five six…");
    expect(wordsPreview("one two")).toBe("one two");
  });
});

describe("reviewOf", () => {
  const first = ask({ recommends: { intent: "yes", why: "safe" } });
  const second = ask();
  const third = ask();
  it("gives the exact message of answersMessage, its length and the count", () => {
    const drafts = new Map<string, AskDraft>([[first.id, { intent: "yes", text: "" }], [third.id, { intent: HILL_MORE_CONTEXT, text: "which repo?" }]]);
    const review = reviewOf([first, second, third], drafts);
    expect(review.count).toBe(2);
    expect(review.answers.map((answer) => answer.ask.id)).toEqual([first.id, third.id]);
    expect(review.message.split("\n")).toHaveLength(3);
    expect(review.message).toContain(`${first.id} "${first.title}": yes (Yes), as recommended.`);
    expect(review.message).toContain(`${second.id} "${second.title}": no answer yet, it stays open.`);
    expect(review.length).toBe([...review.message].length);
    expect(review).toMatchObject({ max: 4000, over: 0, tooLong: false, canSend: true });
  });
  it("blocks Send with no answer and says how far over a long message is", () => {
    expect(reviewOf([first], new Map()).canSend).toBe(false);
    const long = reviewOf([first], new Map([[first.id, { intent: "yes", text: "x".repeat(4100) }]]));
    expect(long.tooLong).toBe(true);
    expect(long.over).toBe(long.length - 4000);
    expect(long.canSend).toBe(false);
  });
  it("lists the marked answers in the session's order whatever order the drafts were made in", () => {
    const drafts = new Map<string, AskDraft>([[third.id, { intent: "no", text: "" }], [first.id, { intent: "yes", text: "" }]]);
    expect(markedAnswersOf([first, second, third], drafts).map((answer) => answer.ask.id)).toEqual([first.id, third.id]);
  });
});

describe("foldsOf", () => {
  function closed(rid: string, key: string, at: number, over: Partial<HillDecision> = {}): AskDecision {
    return ask(
      {
        state: "answered",
        closedAt: at,
        // SAFETY: a test answer; the fields this file does not read are left out.
        answer: { rid, intent: "yes", label: "Yes", text: null, by: "phone", at, delivery: "typed" } as NonNullable<HillDecision["answer"]>,
        ...over,
      },
      {},
      key,
    );
  }
  it("folds the asks one Send closed into one line, newest Send first, a Send per session", () => {
    const k = "lodge/w6:p3#tok1";
    const folds = foldsOf([closed("r1", k, 100), closed("r1", k, 101), closed("r2", k, 500), closed("r1", "lodge/w7:p1#tok2", 300)]);
    expect(folds.map((f) => [f.rid, f.key, f.asks.length, f.at])).toEqual([
      ["r2", k, 1, 500],
      ["r1", "lodge/w7:p1#tok2", 1, 300],
      ["r1", k, 2, 101],
    ]);
  });
  it("leaves out a closed ask that was not answered, and a closed Decision that is no ask", () => {
    const k = "lodge/w6:p3#tok1";
    expect(foldsOf([closed("r1", k, 100, { state: "withdrawn", answer: null }), hillDecision({ state: "answered" })])).toEqual([]);
  });
});

describe("closedAskWhy", () => {
  it("names why a closed ask closed, and says nothing of an open one", () => {
    const base = { closedReason: null, supersededBy: null, answer: null } as const;
    expect(closedAskWhy({ ...base, state: "open" })).toBeNull();
    expect(closedAskWhy({ ...base, state: "superseded", supersededBy: "ak_new000000000" })).toEqual({ kind: "replaced", by: "ak_new000000000" });
    expect(closedAskWhy({ ...base, state: "withdrawn", closedReason: "answered in the session" })).toEqual({ kind: "answeredHere" });
    expect(closedAskWhy({ ...base, state: "withdrawn", closedReason: "by the poster: wrong repo" })).toEqual({ kind: "takenBack", because: "wrong repo" });
    expect(closedAskWhy({ ...base, state: "undeliverable" })).toEqual({ kind: "gone" });
  });
});

describe("askFileRequest and mayOpenFile", () => {
  const file = { path: "docs/plan.md", heading: "Risks", line: 12 };
  it("builds the request from the ask's root and the sender's machine", () => {
    const a = ask({}, { files: [file], root: "w6:p3" });
    expect(askFileRequest(a, file, "lodge")).toEqual({ paneId: "w6:p3", scope: {}, path: "docs/plan.md", heading: "Risks", line: 12 });
    const member = { ...a, from: { ...a.from, memberId: "workshop" } };
    expect(askFileRequest(member, { path: "a.md" }, "lodge")).toEqual({ paneId: "w6:p3", scope: { host: "workshop" }, path: "a.md" });
    expect(askFileRequest({ ...a, from: { ...a.from, memberId: "lodge" } }, file, "lodge")?.scope).toEqual({});
  });
  it("has no request without a root", () => {
    expect(askFileRequest(ask({}, { root: null }), file, "lodge")).toBeNull();
  });
  it("may open only with a root, a live pane that has a folder, and a machine with a screen", () => {
    const facts = { pane: pane() };
    expect(mayOpenFile({ root: "w6:p3" }, facts, false)).toBe(true);
    expect(mayOpenFile({ root: null }, facts, false)).toBe(false);
    expect(mayOpenFile({ root: "w6:p3" }, { pane: null }, false)).toBe(false);
    expect(mayOpenFile({ root: "w6:p3" }, { pane: pane({ cwd: "" }) }, false)).toBe(false);
    expect(mayOpenFile({ root: "w6:p3" }, facts, true)).toBe(false);
  });
});
