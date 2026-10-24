// The pane's model label from two sources: the log (exact, per turn) and the start hook (there from
// the first moment). Lab facts behind each case: bridge/pane-model.ts.

import { describe, expect, test } from "bun:test";

import { displayModel, journalModelShown, paneModel, sameModel } from "./pane-model.ts";

const T = 1_792_868_974_998;

describe("the pane's model", () => {
  test("a fresh session with no log shows the start hook's model, its window tag removed", () => {
    expect(paneModel(undefined, { model: "claude-sonnet-5-5", at: T })).toBe("claude-sonnet-5-5");
    expect(paneModel(undefined, { model: "claude-opus-5-5[1m]", at: T })).toBe("claude-opus-5-5");
  });

  test("no source, no model", () => {
    expect(paneModel(undefined, undefined)).toBeUndefined();
    expect(paneModel(undefined, { model: "[1m]", at: T })).toBeUndefined();
  });

  test("a log reading taken after the start wins: a /model before the first message, then the first turn", () => {
    const hook = { model: "claude-sonnet-5-5", at: T };
    expect(paneModel({ model: "Opus 5.5", at: T + 10_000 }, hook)).toBe("Opus 5.5");
    expect(paneModel({ model: "claude-opus-5-5", at: T + 60_000 }, hook)).toBe("claude-opus-5-5");
  });

  test("a start that came after the log's reading and names another model replaces it", () => {
    // A resume on another model, or a new session in the same pane before the log knows it.
    expect(paneModel({ model: "claude-sonnet-5-5", at: T - 60_000 }, { model: "claude-opus-5-5[1m]", at: T })).toBe("claude-opus-5-5");
  });

  test("a start that names the same model keeps the log's words", () => {
    expect(paneModel({ model: "Opus 5.5", at: T - 60_000 }, { model: "claude-opus-5-5[1m]", at: T })).toBe("Opus 5.5");
  });

  test("a log reading with no time (an older ledger) always wins", () => {
    expect(paneModel({ model: "gpt-5.6-sol", at: Number.POSITIVE_INFINITY }, { model: "claude-opus-5-5", at: T })).toBe("gpt-5.6-sol");
  });

  test("the effort rides only with the log's own model", () => {
    const journal = { model: "claude-sonnet-5-5", at: T - 60_000 };
    expect(journalModelShown(journal, undefined)).toBe(true);
    expect(journalModelShown(journal, { model: "claude-opus-5-5", at: T })).toBe(false);
    expect(journalModelShown(undefined, { model: "claude-opus-5-5", at: T })).toBe(false);
  });

  test("one model however each source spells it", () => {
    expect(sameModel("claude-opus-5-5[1m]", "Opus 5.5")).toBe(true);
    expect(sameModel("claude-opus-5-5", "Opus 5 (1M context)")).toBe(false);
    expect(sameModel("openrouter:openai/gpt-5.6-sol", "OPENROUTER:openai/gpt-5.6-sol")).toBe(true);
    expect(displayModel(" claude-opus-5-5[1m] ")).toBe("claude-opus-5-5");
  });
});
