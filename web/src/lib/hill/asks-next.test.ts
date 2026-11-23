import { describe, expect, it } from "vitest";

import { askAddress, askDecision, askPane } from "@/test/asks-fixtures";
import { HILL_T0 } from "@/test/hill-fixtures";

import { groupAsks } from "./asks";
import { cacheBarPercent, cacheClockOf, cacheClockWords, headerAsksWords, nextUpLine, orderByClock, sectionCountWords } from "./asks-board";
import type { AskDraft } from "./asks-drafts";
import { clearAsksSendRequest, nextUpOf, openAskCount, requestAsksSend } from "./asks-next";

const NOW = HILL_T0 + 3_600_000;
const MIN = 60_000;
const LIVE = { lead: undefined, panes: [askPane("w1:p1", { cache: { warmMinutes: 12, now: NOW } }), askPane("w1:p2", { status: "working" })] };

function sessions(...asks: ReturnType<typeof askDecision>[]) {
  return orderByClock(groupAsks(asks), LIVE, NOW);
}

const A1 = askDecision({ id: "ak_a1", address: askAddress("w1:p1"), at: HILL_T0 });
const A2 = askDecision({ id: "ak_a2", address: askAddress("w1:p1"), at: HILL_T0 + 1 });
const B1 = askDecision({ id: "ak_b1", address: askAddress("w1:p2"), at: HILL_T0 + 2 });

const pick = (...ids: string[]) => new Map<string, AskDraft>(ids.map((id) => [id, { intent: "keep", text: "" }]));

describe("the Next up offer", () => {
  it("is the first open ask of the board with no answer marked here", () => {
    const board = sessions(A1, A2, B1);
    expect(nextUpOf(board, new Map())).toMatchObject({ kind: "ask", ask: { id: "ak_a1" } });
    expect(nextUpOf(board, pick("ak_a1"))).toMatchObject({ kind: "ask", ask: { id: "ak_a2" } });
    // The first session is fully marked: the next ask is the second session's.
    expect(nextUpOf(board, pick("ak_a1", "ak_a2"))).toMatchObject({ kind: "ask", ask: { id: "ak_b1" }, session: { key: askAddress("w1:p2") } });
  });

  it("offers the Send of the first session with marks when every ask has one", () => {
    const board = sessions(A1, A2, B1);
    expect(nextUpOf(board, pick("ak_a1", "ak_a2", "ak_b1"))).toMatchObject({ kind: "send", answered: 2, total: 2, session: { key: askAddress("w1:p1") } });
  });

  it("is nothing when no ask is open", () => {
    expect(nextUpOf([], new Map())).toBeNull();
    expect(openAskCount([])).toBe(0);
    expect(openAskCount(sessions(A1, A2, B1))).toBe(3);
  });
});

describe("the muted line beside Answer", () => {
  it("says the cache runs out first only with two sessions and a warm one", () => {
    expect(nextUpLine(2, { kind: "warm", msLeft: 12 * MIN })).toBe("Its cache runs out first. After that, an answer costs a full re-read.");
    expect(nextUpLine(3, { kind: "warm" })).toBe("Its cache runs out first. After that, an answer costs a full re-read.");
  });

  it("says a working session takes the answer at its turn end", () => {
    expect(nextUpLine(2, { kind: "working" })).toBe("The session works. Your answer waits for its turn end.");
  });

  it("says nothing for a cold or unknown session, and nothing for a single session", () => {
    expect(nextUpLine(2, { kind: "cold" })).toBeNull();
    expect(nextUpLine(2, { kind: "unknown" })).toBeNull();
    expect(nextUpLine(1, { kind: "warm", msLeft: 12 * MIN })).toBeNull();
    expect(nextUpLine(1, { kind: "working" })).toBeNull();
  });
});

describe("the cache clock of the board", () => {
  it("keeps a working pane's cache reading, cold, or nothing", () => {
    expect(cacheClockOf(askPane("w1:p1", { status: "working", cache: { warmMinutes: 57, now: NOW } }), NOW)).toEqual({ kind: "warm", msLeft: 57 * MIN });
    expect(cacheClockOf(askPane("w1:p1", { cache: "cold" }), NOW)).toEqual({ kind: "cold" });
    expect(cacheClockOf(askPane("w1:p1"), NOW)).toEqual({ kind: "none" });
    expect(cacheClockOf(null, NOW)).toEqual({ kind: "none" });
  });

  it("says the minutes left, cold, or nothing", () => {
    expect(cacheClockWords({ kind: "warm", msLeft: 12 * MIN })).toBe("12 min left");
    expect(cacheClockWords({ kind: "warm", msLeft: 30_000 })).toBe("under 1 min left");
    expect(cacheClockWords({ kind: "warm" })).toBe("warm");
    expect(cacheClockWords({ kind: "cold" })).toBe("cold");
    expect(cacheClockWords({ kind: "none" })).toBeNull();
  });

  it("fills its bar by the whole minutes left out of 60", () => {
    expect(cacheBarPercent(60 * MIN)).toBe(100);
    expect(cacheBarPercent(12 * MIN)).toBeCloseTo(20);
    expect(cacheBarPercent(57 * MIN)).toBeCloseTo(95);
    expect(cacheBarPercent(1 * MIN)).toBeCloseTo(1.667, 2);
    expect(cacheBarPercent(0)).toBe(0);
    expect(cacheBarPercent(30_000)).toBe(0);
    expect(cacheBarPercent(90 * MIN)).toBe(100);
  });
});

describe("the counts of the page", () => {
  it("says the header's sub line with the sessions", () => {
    expect(headerAsksWords(1, 1)).toBe("1 open in 1 session");
    expect(headerAsksWords(5, 1)).toBe("5 open in 1 session");
    expect(headerAsksWords(5, 3)).toBe("5 open in 3 sessions");
  });

  it("says the section line, the answered part only when there is one", () => {
    expect(sectionCountWords(5, 1)).toBe("5 open · 1 answered");
    expect(sectionCountWords(5, 0)).toBe("5 open");
  });
});

describe("the request a shortcut makes of the board", () => {
  it("is kept until the board clears it", () => {
    requestAsksSend("local/w1:p1#a1b2");
    clearAsksSendRequest();
    clearAsksSendRequest();
  });
});
