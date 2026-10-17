import { beforeEach, describe, expect, it, vi } from "vitest";

// Typing an answer into a wizard step's field (ADR 0113, grammar/ASK_FIELD_NOTES.md § Wizard): the
// shared recipe (lib/answer-field.ts) plus one bound Enter, which answers the step and advances it.
// The api layer is mocked so every fresh screen is scripted; the detector and the guard are the real
// thing. Each test pins one rule, and what was NOT sent.
vi.mock("./api", () => ({
  fetchPane: vi.fn(),
  sendKeys: vi.fn(),
  sendReply: vi.fn(),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchPane, sendKeys, sendReply } from "./api";
import { parseAnsi } from "./ansi";
import { splitLines, type WizardModel } from "./blocks";
import { detectWizard } from "./harness/claude/wizard";
import { submitWizardAnswer, submitWizardKeys } from "./wizard-action";

const mockFetchPane = vi.mocked(fetchPane);
const mockSendKeys = vi.mocked(sendKeys);
const mockSendReply = vi.mocked(sendReply);

/** Where `❯` stands: on an option (0-1), on the field (2), on `Chat about this` (3). */
type Pointer = 0 | 1 | 2 | 3;

// Step 1 of a three-question wizard in the 2.1.299 layout (fixtures claude--v2299-ask-field-wizard-*):
// the field is row 3, ruled off from `Chat about this`; a revisited step answered by typing carries the
// field's ` ✔` (two spaces before it while the caret cell shows); the footer names ctrl+g while focused.
function wiz(pointer: Pointer, text = "", revisited = false): string {
  const mark = (i: number) => (i === pointer ? "❯" : " ");
  const box = revisited ? "☒" : "☐";
  const tick = !revisited ? "" : pointer === 2 && text !== "" ? "  ✔" : " ✔";
  return [
    "❯ Ask me three things.",
    "─".repeat(80),
    `←  ${box} Fruit  ${box} Drink  ${box} City  ✔ Submit  →`,
    "",
    "Which fruit?",
    "",
    `${mark(0)} 1. Apple`,
    "     A crisp fruit",
    `${mark(1)} 2. Pear`,
    "     A soft, sweet fruit",
    `${mark(2)} 3. ${text === "" ? "Type something." : text}${tick}`,
    "─".repeat(80),
    `${mark(3)} 4. Chat about this`,
    "",
    pointer === 2
      ? "Enter to select · Tab/Arrow keys to navigate · ctrl+g to edit in Notepad · Esc to cancel"
      : "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
  ].join("\n");
}

function model(text: string): WizardModel {
  const m = detectWizard(splitLines(parseAnsi(text)));
  if (!m) throw new Error("synthetic screen did not detect");
  return m;
}

const fieldOf = (m: WizardModel) => (m.phase === "question" ? m.field : undefined);
const pane = (text: string) => ({ paneId: "w1:p1", text, truncated: false, revision: 5 });

/** Script the screens the reads return, in order; the last one repeats. */
function screens(...texts: string[]) {
  for (const text of texts.slice(0, -1)) mockFetchPane.mockResolvedValueOnce(pane(text));
  mockFetchPane.mockResolvedValue(pane(texts.at(-1)!));
}

function answer(tapped: string, text = "Kiwi") {
  return submitWizardAnswer({
    paneId: "w1:p1",
    requestedLines: 600,
    detectedRevision: 5,
    agent: "claude",
    wizard: model(tapped),
    text,
    sleep: async () => {},
  });
}

const keys = () => mockSendKeys.mock.calls.map((c) => c[1]);
const CLEAR = ["ctrl+u", "ctrl+k"];
const PANES = join(import.meta.dirname, "..", "fixtures", "panes");
const capture = (name: string) => model(readFileSync(join(PANES, `claude--v2299-ask-field-${name}.txt`), "utf8"));

beforeEach(() => {
  mockFetchPane.mockReset();
  mockSendKeys.mockReset();
  mockSendReply.mockReset();
  mockSendKeys.mockResolvedValue({ ok: true });
  mockSendReply.mockResolvedValue({ ok: true });
});

describe("the synthetic step reads like the 2.1.299 captures", () => {
  it("the same field in every state the recipe walks through", () => {
    expect(fieldOf(model(wiz(2)))).toEqual(fieldOf(capture("wizard-focused-empty")));
    expect(fieldOf(model(wiz(2, "Mango")))).toEqual(fieldOf(capture("wizard-focused-typed")));
    expect(fieldOf(model(wiz(0, "Mango", true)))).toEqual(fieldOf(capture("wizard-revisit-typed")));
    expect(fieldOf(model(wiz(2, "Mango", true)))).toEqual(fieldOf(capture("wizard-revisit-focused")));
    expect(fieldOf(model(wiz(2, "", true)))).toEqual(fieldOf(capture("wizard-revisit-cleared")));
  });
});

describe("submitWizardAnswer — one rule per test", () => {
  it("an empty field: its digit, the text, then ONE Enter bound to the read that proved the text", async () => {
    const tapped = wiz(0);
    screens(tapped, wiz(2), wiz(2, "Kiwi"));
    expect(await answer(tapped)).toEqual({ status: "sent" });
    expect(keys()).toEqual([["3"], ["Enter"]]);
    expect(mockSendKeys.mock.calls[1]![3]).toBe(model(wiz(2, "Kiwi")).signature);
    expect(mockSendReply.mock.calls).toEqual([["w1:p1", "Kiwi", false, undefined]]);
  });

  it("a revisited, filled field: NEVER its digit; Down onto it, clear, type, then Enter", async () => {
    const tapped = wiz(0, "Mango", true);
    screens(
      tapped, // entry guard
      tapped, // the walk's first read
      wiz(1, "Mango", true),
      wiz(2, "Mango", true), // the walk lands
      wiz(2, "Mango", true), // the reach proof
      wiz(2, "", true), // one clear round emptied it
      wiz(2, "Kiwi", true),
    );
    expect(await answer(tapped)).toEqual({ status: "sent" });
    expect(keys()).toEqual([["Down"], ["Down"], CLEAR, ["Enter"]]);
    expect(keys()).not.toContainEqual(["3"]);
    expect(mockSendKeys.mock.calls[3]![3]).toBe(model(wiz(2, "Kiwi", true)).signature);
  });

  it("the field no longer holds what the person saw: refused, and no Enter", async () => {
    // At the entry guard: someone at the desk changed the answer since the render.
    const tapped = wiz(0, "Mango", true);
    screens(wiz(0, "Mangos", true));
    expect(await answer(tapped)).toEqual({ status: "changed", why: "entry" });
    expect(mockSendKeys).not.toHaveBeenCalled();

    // In the walk: after one arrow the field reads differently, and nothing follows.
    mockFetchPane.mockReset();
    screens(tapped, tapped, wiz(1, "Mangos", true));
    expect(await answer(tapped)).toEqual({ status: "changed", why: "walk: text" });
    expect(keys()).toEqual([["Down"]]);
    expect(mockSendReply).not.toHaveBeenCalled();
  });
});

describe("submitWizardKeys while the field has focus", () => {
  it("refuses an option digit: the terminal would type it into the field", async () => {
    const res = await submitWizardKeys({
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision: 5,
      agent: "claude",
      wizard: model(wiz(2)),
      keys: ["1"],
    });
    expect(res).toEqual({ status: "changed" });
    expect(mockFetchPane).not.toHaveBeenCalled();
    expect(mockSendKeys).not.toHaveBeenCalled();
  });
});
