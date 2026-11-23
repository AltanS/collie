import { describe, expect, it } from "vitest";

import { answerLine, answersMessage, answersMessageLength, answersMessageOver, ASKS_ANSWERS_SUBJECT, openLine, type AnsweredAsk } from "./answers-message.ts";
import { askTakenBack, askTakenBackBecause, HILL_ANSWERS_MESSAGE_MAX, HILL_ASK_ID_RE, HILL_BY_THE_POSTER, HILL_ID_RE, HILL_MORE_CONTEXT, HILL_OWN_ANSWER, isHillOptionIntent } from "./wire.ts";

const withRec: AnsweredAsk = {
  id: "ak_aaaaaaaaaaaa",
  title: "Ship the fix on Edge first?",
  recommends: { intent: "edge", why: "Testers see it first." },
  options: [
    { intent: "edge", label: "Ship it on Edge first" },
    { intent: "stable", label: "Ship it on Stable now" },
  ],
};
const noRec: AnsweredAsk = { ...withRec, id: "ak_bbbbbbbbbbbb", title: "Which branch takes it?", recommends: null };
const words: AnsweredAsk = { id: "ak_cccccccccccc", title: "What should the page say first?", recommends: null, options: [] };

describe("the answers message", () => {
  it("says an answer that takes the recommendation", () => {
    expect(answerLine({ ask: withRec, intent: "edge", text: null })).toBe('ak_aaaaaaaaaaaa "Ship the fix on Edge first?": edge (Ship it on Edge first), as recommended.');
  });

  it("says an answer that is not the recommended option, with its note", () => {
    expect(answerLine({ ask: withRec, intent: "stable", text: "The testers are away." })).toBe('ak_aaaaaaaaaaaa "Ship the fix on Edge first?": stable (Ship it on Stable now), not the recommended option. Note: The testers are away.');
  });

  it("says an answer to an ask with no recommendation", () => {
    expect(answerLine({ ask: noRec, intent: "edge", text: "  " })).toBe('ak_bbbbbbbbbbbb "Which branch takes it?": edge (Ship it on Edge first).');
    expect(answerLine({ ask: noRec, intent: "edge", text: "main" })).toBe('ak_bbbbbbbbbbbb "Which branch takes it?": edge (Ship it on Edge first). Note: main');
  });

  it("says I need more context, with the way to ask again", () => {
    const tail = "Send the ask again with a better background: collie walky ask ... --replaces ak_aaaaaaaaaaaa";
    expect(answerLine({ ask: withRec, intent: HILL_MORE_CONTEXT, text: null })).toBe(`ak_aaaaaaaaaaaa "Ship the fix on Edge first?": I need more context. ${tail}`);
    expect(answerLine({ ask: withRec, intent: HILL_MORE_CONTEXT, text: "What is Edge" })).toBe(`ak_aaaaaaaaaaaa "Ship the fix on Edge first?": I need more context. Note: What is Edge. ${tail}`);
    expect(answerLine({ ask: withRec, intent: HILL_MORE_CONTEXT, text: "What is Edge?" })).toBe(`ak_aaaaaaaaaaaa "Ship the fix on Edge first?": I need more context. Note: What is Edge? ${tail}`);
  });

  it("says Your own answer with its text, further lines indented", () => {
    expect(answerLine({ ask: withRec, intent: HILL_OWN_ANSWER, text: "Ship both, Edge today." })).toBe('ak_aaaaaaaaaaaa "Ship the fix on Edge first?": Your own answer: Ship both, Edge today.');
    expect(answerLine({ ask: noRec, intent: HILL_OWN_ANSWER, text: "Neither.\nWait a week." })).toBe('ak_bbbbbbbbbbbb "Which branch takes it?": Your own answer: Neither.\n  Wait a week.');
  });

  it("carries the words of a --words ask, further lines indented", () => {
    expect(answerLine({ ask: words, intent: "answer", text: "Lead with the phone.\nThen the crew." })).toBe('ak_cccccccccccc "What should the page say first?": Lead with the phone.\n  Then the crew.');
  });

  it("puts the open asks that got no answer last, and leaves out an answered one", () => {
    const message = answersMessage([{ ask: noRec, intent: "stable", text: null }], [withRec, noRec, words]);
    expect(message.split("\n")).toEqual([
      'ak_bbbbbbbbbbbb "Which branch takes it?": stable (Ship it on Stable now).',
      openLine(withRec),
      'ak_cccccccccccc "What should the page say first?": no answer yet, it stays open.',
    ]);
  });

  it("counts code points and says how far over the limit a message is", () => {
    expect(answersMessageLength("aé😀")).toBe(3);
    expect(answersMessageOver("x".repeat(HILL_ANSWERS_MESSAGE_MAX))).toBe(0);
    expect(answersMessageOver("x".repeat(HILL_ANSWERS_MESSAGE_MAX + 7))).toBe(7);
  });

  it("has a subject WalkyTalky takes: at most six words", () => {
    expect(ASKS_ANSWERS_SUBJECT.split(" ").length).toBeLessThanOrEqual(6);
  });
});

describe("the ask ids and words on the wire", () => {
  it("takes ak_ and an old lead's dc_ as card ids, and only ak_ as an ask id", () => {
    expect(HILL_ID_RE.test("ak_000000000000")).toBe(true);
    expect(HILL_ID_RE.test("dc_000000000000")).toBe(true);
    expect(HILL_ID_RE.test("wt_000000000000")).toBe(false);
    expect(HILL_ASK_ID_RE.test("ak_000000000000")).toBe(true);
    expect(HILL_ASK_ID_RE.test("dc_000000000000")).toBe(false);
  });

  it("reserves more-context and own: no option may take them", () => {
    expect(isHillOptionIntent(HILL_MORE_CONTEXT)).toBe(false);
    expect(isHillOptionIntent(HILL_OWN_ANSWER)).toBe(false);
  });

  it("round-trips the agent's reason of a take back", () => {
    expect(askTakenBack(null)).toBe(HILL_BY_THE_POSTER);
    expect(askTakenBackBecause(askTakenBack(null))).toBeNull();
    expect(askTakenBackBecause(askTakenBack("The test already answers it."))).toBe("The test already answers it.");
  });
});
