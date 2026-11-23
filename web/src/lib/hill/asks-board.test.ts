import { describe, expect, it } from "vitest";

import { askAddress, askDecision, askPane } from "@/test/asks-fixtures";
import { HILL_T0 } from "@/test/hill-fixtures";

import { groupAsks } from "./asks";
import { askedWords, boardCountWords, clockWords, contextFacts, contextSummary, deckOf, headerLine, markWords, neighboursOf, orderByClock, sendLineWords, sessionClock, sortSessionAsks, wordCount } from "./asks-board";

const NOW = HILL_T0 + 3_600_000;

function sessionsOf(...asks: ReturnType<typeof askDecision>[]) {
  return groupAsks(asks);
}

describe("the clock of a session", () => {
  it("is working while the pane works, whatever its cache says", () => {
    expect(sessionClock(askPane("w1:p1", { status: "working", cache: { warmMinutes: 4, now: NOW } }), NOW)).toEqual({ kind: "working" });
  });

  it("is warm with the minutes left, cold, or unknown", () => {
    expect(sessionClock(askPane("w1:p1", { cache: { warmMinutes: 4, now: NOW } }), NOW)).toEqual({ kind: "warm", msLeft: 240_000 });
    expect(sessionClock(askPane("w1:p1", { cache: "cold" }), NOW)).toEqual({ kind: "cold" });
    expect(sessionClock(askPane("w1:p1"), NOW)).toEqual({ kind: "unknown" });
    expect(sessionClock(null, NOW)).toEqual({ kind: "unknown" });
  });

  it("says each clock in words, and nothing for an unknown one", () => {
    expect(clockWords({ kind: "working" })).toBe("working");
    expect(clockWords({ kind: "cold" })).toBe("cold");
    expect(clockWords({ kind: "warm" })).toBe("warm");
    expect(clockWords({ kind: "warm", msLeft: 38 * 60_000 })).toBe("warm, 38 min left");
    expect(clockWords({ kind: "warm", msLeft: 30_000 })).toBe("warm, under 1 min left");
    expect(clockWords({ kind: "unknown" })).toBeNull();
  });
});

describe("the order of the sessions", () => {
  const live = {
    lead: undefined,
    panes: [
      askPane("w1:p1", { cache: "cold" }),
      askPane("w1:p2", { cache: { warmMinutes: 40, now: NOW } }),
      askPane("w1:p3", { cache: { warmMinutes: 5, now: NOW } }),
      askPane("w1:p4", { status: "working" }),
      askPane("w1:p5"),
    ],
  };
  const asks = ["w1:p1", "w1:p2", "w1:p3", "w1:p4", "w1:p5"].map((pane, at) => askDecision({ address: askAddress(pane), label: pane, at: HILL_T0 + at }));

  it("puts warm first with the fewest minutes left, then working, then unknown, then cold", () => {
    const order = orderByClock(sessionsOf(...asks), live, NOW).map((session) => session.label);
    expect(order).toEqual(["w1:p3", "w1:p2", "w1:p4", "w1:p5", "w1:p1"]);
  });

  it("keeps the place of a session the page drew before, and puts a new one on top", () => {
    const first = orderByClock(sessionsOf(...asks.slice(0, 3)), live, NOW);
    const held = first.map((session) => session.key);
    const again = orderByClock(sessionsOf(...asks), live, NOW, held);
    expect(again.map((session) => session.label)).toEqual(["w1:p4", "w1:p5", "w1:p3", "w1:p2", "w1:p1"]);
  });

  it("lets a session with no ask left drop out", () => {
    const held = orderByClock(sessionsOf(...asks), live, NOW).map((session) => session.key);
    const left = orderByClock(sessionsOf(...asks.slice(1)), live, NOW, held);
    expect(left.map((session) => session.label)).not.toContain("w1:p1");
  });
});

describe("the asks of one session", () => {
  it("sinks the unchecked ones to the end, each part in age order", () => {
    const a = askDecision({ title: "a", at: HILL_T0 + 1 });
    const b = askDecision({ title: "b", at: HILL_T0 + 2, mark: "unchecked" });
    const c = askDecision({ title: "c", at: HILL_T0 + 3 });
    const d = askDecision({ title: "d", at: HILL_T0, mark: "unchecked" });
    expect(sortSessionAsks([c, b, a, d]).map((ask) => ask.title)).toEqual(["a", "c", "d", "b"]);
  });
});

describe("the deck", () => {
  it("walks the sessions in board order, each one's asks in their order", () => {
    const live = { lead: undefined, panes: [askPane("w1:p1", { cache: "cold" }), askPane("w1:p2", { cache: { warmMinutes: 9, now: NOW } })] };
    const asks = [askDecision({ id: "dc_a", address: askAddress("w1:p1") }), askDecision({ id: "dc_b", address: askAddress("w1:p2") }), askDecision({ id: "dc_c", address: askAddress("w1:p2"), at: HILL_T0 + 5 })];
    const deck = deckOf(orderByClock(groupAsks(asks), live, NOW));
    expect(deck.map((ask) => ask.id)).toEqual(["dc_b", "dc_c", "dc_a"]);
    expect(neighboursOf(deck, "dc_b")).toEqual({ previous: null, next: "dc_c" });
    expect(neighboursOf(deck, "dc_a")).toEqual({ previous: "dc_c", next: null });
    expect(neighboursOf(deck, "dc_zzz")).toEqual({ previous: null, next: null });
  });
});

describe("the words of the pages", () => {
  it("counts the words of a background", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount("  one   two\nthree ")).toBe(3);
  });

  it("sums up what is behind an ask, and says nothing when it holds nothing", () => {
    expect(contextSummary({ words: 165, images: 2, files: 1 })).toBe("165 words · 2 images · 1 file");
    expect(contextSummary({ words: 0, images: 1, files: 0 })).toBe("1 image");
    expect(contextSummary({ words: 0, images: 0, files: 0 })).toBeNull();
    const ask = askDecision({ body: "one two", files: [{ path: "a.md" }, { path: "b.md" }] });
    expect(contextFacts(ask)).toEqual({ words: 2, images: 0, files: 2 });
  });

  it("writes the header line and the age of an ask", () => {
    expect(askedWords(HILL_T0, HILL_T0 + 14 * 3_600_000)).toBe("asked 14 h ago");
    expect(headerLine(HILL_T0, { kind: "cold" }, HILL_T0 + 14 * 3_600_000)).toBe("asked 14 h ago · cold");
    expect(headerLine(HILL_T0, { kind: "unknown" }, HILL_T0 + 14 * 3_600_000)).toBe("asked 14 h ago");
  });

  it("writes the three marks", () => {
    const fresh = askDecision({ mark: "fresh" });
    expect(markWords("fresh", fresh)).toMatch(/^Asked \d{1,2}:\d{2}/u);
    expect(markWords("carried", askDecision({ mark: "carried", confirmedAt: HILL_T0 + 60_000 }))).toMatch(/^Still open\. The agent saw it \d{1,2}:\d{2}/u);
    expect(markWords("carried", askDecision({ mark: "carried" }))).toBe("Still open. The agent saw it.");
    expect(markWords("unchecked", askDecision({ mark: "unchecked" }))).toBe("You wrote in this session since. Not checked.");
  });

  it("writes the send line so that it always has words", () => {
    expect(sendLineWords(0, 4)).toEqual({ words: "No answers yet", action: null });
    expect(sendLineWords(2, 4)).toEqual({ words: "2 of 4 answered", action: "Send 2" });
  });

  it("counts a card's questions, the answered ones and the unchecked ones", () => {
    expect(boardCountWords(1, 0, 0)).toBe("1 question");
    expect(boardCountWords(4, 0, 0)).toBe("4 questions");
    expect(boardCountWords(4, 2, 0)).toBe("2 of 4 answered");
    expect(boardCountWords(4, 2, 1)).toBe("2 of 4 answered · 1 not checked");
  });
});
