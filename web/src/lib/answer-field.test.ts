import { beforeEach, describe, expect, it, vi } from "vitest";

// The answer-field recipe (ADR 0113, grammar/ASK_FIELD_NOTES.md), driven through a single
// AskUserQuestion: reach the field (its digit only while empty, else a verified walk), clear only what
// the person saw, type, and prove the text. The api layer is mocked so every fresh screen is scripted;
// the detector and the guard are the real thing. Each test pins one rule, and what was NOT sent.
vi.mock("./api", () => ({
  fetchPane: vi.fn(),
  sendKeys: vi.fn(),
  sendReply: vi.fn(),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchPane, sendKeys, sendReply } from "./api";
import { parseAnsi } from "./ansi";
import { ANSWER_MAX_LENGTH, MAX_CLEAR_ROUNDS, answerFits, fillAnswerField, type FieldAccess } from "./answer-field";
import { splitLines, type PromptModel } from "./blocks";
import { MAX_ANSWER_WRAP, detectPromptSelect } from "./harness/claude/prompt-select";
import { promptsSameIdentity } from "./harness/prompt-model";
import { t } from "./i18n";

const mockFetchPane = vi.mocked(fetchPane);
const mockSendKeys = vi.mocked(sendKeys);
const mockSendReply = vi.mocked(sendReply);

/** Where `❯` stands: on an option (0-2), on the field (3), on `Chat about this` (4). */
type Pointer = 0 | 1 | 2 | 3 | 4;

// A single AskUserQuestion in the 2.1.299 layout (fixtures claude--v2299-ask-field-single-*.txt): the
// field is row 4, ruled off from `Chat about this`, and the footer names ctrl+g while it is focused.
function ask(pointer: Pointer, text = "", question = "Which color do you prefer?", width = 80): string {
  const mark = (i: number) => (i === pointer ? "❯" : " ");
  const options = [
    ["Red", "A warm color"],
    ["Green", "A calm color"],
    ["Blue", "A cool color"],
  ] as const;
  return [
    "❯ Ask me which color I prefer.",
    "─".repeat(width),
    " ☐ Color ",
    "",
    question,
    "",
    ...options.flatMap(([label, description], i) => [`${mark(i)} ${i + 1}. ${label}`, `     ${description}`]),
    `${mark(3)} 4. ${text === "" ? "Type something." : text}`,
    "─".repeat(width),
    `${mark(4)} 5. Chat about this`,
    "",
    pointer === 3
      ? "Enter to select · ↑/↓ to navigate · ctrl+g to edit in Notepad · Esc to cancel"
      : "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");
}

function model(text: string): PromptModel {
  const m = detectPromptSelect(splitLines(parseAnsi(text)));
  if (!m) throw new Error("synthetic screen did not detect");
  return m;
}

const pane = (text: string) => ({ paneId: "w1:p1", text, truncated: false, revision: 5 });

function access(tapped: PromptModel): FieldAccess<"prompt-select"> {
  return {
    fieldOf: (m) => {
      const row = m.feedback;
      if (row?.purpose !== "answer") return null;
      return { key: row.key, focused: row.focused, text: row.text, pointer: row.pointer ?? "none" };
    },
    sameDialog: (m) => promptsSameIdentity(m, tapped),
    digitFocuses: true,
  };
}

function fill(tapped: string, text = "Navy") {
  const prompt = model(tapped);
  const target = {
    paneId: "w1:p1",
    requestedLines: 600,
    detectedRevision: 5,
    agent: "claude",
    kind: "prompt-select" as const,
    model: prompt,
    sleep: async () => {},
  };
  return fillAnswerField(target, access(prompt), text);
}

/** Script the screens the reads return, in order; the last one repeats. */
function screens(...texts: string[]) {
  for (const text of texts.slice(0, -1)) mockFetchPane.mockResolvedValueOnce(pane(text));
  mockFetchPane.mockResolvedValue(pane(texts.at(-1)!));
}

const keys = () => mockSendKeys.mock.calls.map((c) => c[1]);
const CLEAR = ["ctrl+u", "ctrl+k"];

beforeEach(() => {
  mockFetchPane.mockReset();
  mockSendKeys.mockReset();
  mockSendReply.mockReset();
  mockSendKeys.mockResolvedValue({ ok: true });
  mockSendReply.mockResolvedValue({ ok: true });
});

describe("the synthetic screen reads like the 2.1.299 captures", () => {
  const PANES = join(import.meta.dirname, "..", "fixtures", "panes");
  const capture = (name: string) => model(readFileSync(join(PANES, name), "utf8"));

  it("the same field, options and pointer as the real dialog", () => {
    expect(model(ask(3)).feedback).toEqual(capture("claude--v2299-ask-field-single-focused-empty.txt").feedback);
    expect(model(ask(2, "Teal, like the sea")).feedback).toEqual(
      capture("claude--v2299-ask-field-single-typed-off-row.txt").feedback,
    );
    expect(model(ask(0)).options).toEqual(capture("claude--v2299-ask-field-single-focused-empty.txt").options);
    expect(model(ask(4, "Teal")).feedback?.pointer).toBe("below");
  });

  it("focusing the field and filling it keep the dialog's identity", () => {
    expect(promptsSameIdentity(model(ask(3, "Navy")), model(ask(0)))).toBe(true);
    expect(promptsSameIdentity(model(ask(0, "x", "Which colour do you like?")), model(ask(0)))).toBe(false);
  });
});

describe("fillAnswerField — one rule per test", () => {
  it("1. an empty field: its digit, then the text; never a clear", async () => {
    const tapped = ask(0);
    screens(tapped, ask(3), ask(3, "Navy"));
    const res = await fill(tapped);
    expect(res).toMatchObject({ ok: true });
    expect(mockSendKeys.mock.calls).toEqual([["w1:p1", ["4"], undefined, model(tapped).signature]]);
    expect(mockSendReply.mock.calls).toEqual([["w1:p1", "Navy", false, undefined]]);
  });

  it("2. a filled field: NEVER its digit; Down until focused, clear rounds until empty, then the text", async () => {
    const tapped = ask(0, "Teal, like the sea");
    screens(
      tapped, // entry guard
      tapped, // the walk's first read
      ask(1, "Teal, like the sea"),
      ask(2, "Teal, like the sea"),
      ask(3, "Teal, like the sea"), // the walk lands
      ask(3, "Teal, like the sea"), // the reach proof
      ask(3, "Teal,"), // a clear round took one visual line
      ask(3), // the next emptied it
      ask(3, "Navy"),
    );
    const res = await fill(tapped);
    expect(res).toMatchObject({ ok: true });
    expect(keys()).toEqual([["Down"], ["Down"], ["Down"], CLEAR, CLEAR]);
    expect(keys()).not.toContainEqual(["4"]);
    // Each arrow is bound to the read that showed where the pointer stood.
    expect(mockSendKeys.mock.calls[1]![3]).toBe(model(ask(1, "Teal, like the sea")).signature);
    expect(mockSendReply).toHaveBeenCalledTimes(1);
  });

  it("3. a pointer below the field (on Chat about this) walks Up", async () => {
    const tapped = ask(4, "Teal");
    screens(tapped, tapped, ask(3, "Teal"), ask(3, "Teal"), ask(3), ask(3, "Navy"));
    expect(await fill(tapped)).toMatchObject({ ok: true });
    expect(keys()).toEqual([["Up"], CLEAR]);
  });

  it("4. the field no longer holds what the person saw: refused, nothing cleared", async () => {
    // At the entry guard: someone at the desk added words since the render.
    const tapped = ask(1, "Teal");
    screens(ask(1, "Teal, like"));
    expect(await fill(tapped)).toEqual({ ok: false, result: { status: "changed", why: "entry" } });
    expect(mockSendKeys).not.toHaveBeenCalled();

    // In the walk: after one arrow the field reads differently, and no key follows.
    mockFetchPane.mockReset();
    screens(tapped, tapped, ask(2, "Teal, like"));
    expect(await fill(tapped)).toEqual({ ok: false, result: { status: "changed", why: "walk: text" } });
    expect(keys()).toEqual([["Down"]]);
    expect(mockSendReply).not.toHaveBeenCalled();
  });

  it("5. a field that never empties within the cap: an error, and nothing typed", async () => {
    const tapped = ask(3, "Teal");
    let n = 0;
    mockFetchPane.mockImplementation(async () => pane(n++ < 2 ? tapped : ask(3, `left ${n}`)));
    const res = await fill(tapped);
    expect(res).toEqual({ ok: false, result: { status: "error", error: t("promptAction.answer.notCleared") } });
    expect(keys()).toEqual(Array.from({ length: MAX_CLEAR_ROUNDS }, () => CLEAR));
    expect(mockSendReply).not.toHaveBeenCalled();
  });

  it("6. typed text that never appears: an error, and no proof to commit on", async () => {
    const tapped = ask(3);
    screens(tapped, ask(3), ask(3, "Nav"));
    const res = await fill(tapped);
    expect(res).toEqual({ ok: false, result: { status: "error", error: t("promptAction.answer.notArrived") } });
    expect(mockSendReply).toHaveBeenCalledTimes(1);
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("7. the dialog drifts mid-walk: changed, and nothing more is sent", async () => {
    const tapped = ask(0, "Teal");
    screens(tapped, tapped, ask(1, "Teal", "Which colour do you like?"));
    expect(await fill(tapped)).toEqual({ ok: false, result: { status: "changed", why: "walk: drift" } });
    expect(keys()).toEqual([["Down"]]);
    expect(mockSendReply).not.toHaveBeenCalled();
  });

  it("8. already focused and empty: no digit, no walk, the text at once", async () => {
    const tapped = ask(3);
    screens(tapped, ask(3), ask(3, "Navy"));
    const res = await fill(tapped);
    expect(res).toMatchObject({ ok: true });
    if (res.ok) expect(res.proof.feedback?.text).toBe("Navy");
    expect(mockSendKeys).not.toHaveBeenCalled();
    expect(mockSendReply.mock.calls).toEqual([["w1:p1", "Navy", false, undefined]]);
  });

  it("9. a long answer that fits the pane's width is typed whole, not cut at the plan row's 240", async () => {
    // The field case: a 2834-character answer on a 153-column pane (21 display rows on Claude Code
    // 2.1.306, grammar/ASK_FIELD_NOTES.md). The read-back proves every character.
    const long = Array(40).fill("да по поводу deep research я думаю что нужно сначала собрать аналоги.").join(" ").slice(0, 2834);
    const tapped = ask(0, "", undefined, 153);
    screens(tapped, ask(3, "", undefined, 153), ask(3, long, undefined, 153));
    const res = await fill(tapped, long);
    expect(res).toMatchObject({ ok: true });
    expect(mockSendReply.mock.calls).toEqual([["w1:p1", long, false, undefined]]);
  });

  it("10. an answer that would wrap the dialog off a narrow pane: an error before any key", async () => {
    const long = "word ".repeat(600).trim(); // 2999 characters: about 40 rows at 80 columns
    const tapped = ask(0);
    screens(tapped);
    expect(await fill(tapped, long)).toEqual({ ok: false, result: { status: "error", error: t("promptAction.answer.tooLong") } });
    expect(mockSendKeys).not.toHaveBeenCalled();
    expect(mockSendReply).not.toHaveBeenCalled();
  });
});

describe("answerFits", () => {
  const region = (width: number) => ["  1. Red", "─".repeat(width), "  5. Chat about this"].join("\n");

  it("counts the rows of a greedy word wrap after the widest label prefix", () => {
    // 80 columns leave 70 for words after `❯ 4. [✔] ` and the column Claude keeps free: 25 rows of
    // 70 characters fit, one more word does not.
    const row = "x".repeat(70);
    const full = Array(25).fill(row).join(" ");
    expect(answerFits(full, region(80))).toBe(true);
    expect(answerFits(`${full} y`, region(80))).toBe(false);
  });

  it("keeps the whole dialog inside the option scan, the rows the field holds now swapped out", () => {
    // Ten rows of answer on a dialog of 40 rows: 49 rows, one past the scan, so option 1 would be lost.
    const ten = Array(10).fill("x".repeat(70)).join(" ");
    const tall = (rows: number) => [...Array(rows - 1).fill("     a description row"), "─".repeat(80)].join("\n");
    expect(answerFits(ten, tall(39))).toBe(true);
    expect(answerFits(ten, tall(40))).toBe(false);
    // The same dialog while the field holds three rows of an earlier answer: those rows go.
    expect(answerFits(ten, tall(41), Array(3).fill("y".repeat(70)).join(" "))).toBe(true);
  });

  it("a field Collie could fill always empties within the clear rounds", () => {
    expect(MAX_CLEAR_ROUNDS).toBeGreaterThan(MAX_ANSWER_WRAP + 1);
  });

  it("takes the pane's width from the widest row and counts wide characters twice", () => {
    expect(answerFits("x ".repeat(1500).trim(), region(153))).toBe(true);
    expect(answerFits("x ".repeat(1500).trim(), region(60))).toBe(false);
    // 1000 double-width characters are 2000 columns: 28 rows of 74, past the allowance.
    expect(answerFits("漢".repeat(1000), region(80))).toBe(false);
  });

  it("the editor's cap stays above what a wide pane can hold", () => {
    expect(ANSWER_MAX_LENGTH).toBeGreaterThan(2834);
  });
});
