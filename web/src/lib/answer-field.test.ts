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
import { MAX_CLEAR_ROUNDS, fillAnswerField, type FieldAccess } from "./answer-field";
import { splitLines, type PromptModel } from "./blocks";
import { detectPromptSelect } from "./harness/claude/prompt-select";
import { promptsSameIdentity } from "./harness/prompt-model";
import { t } from "./i18n";

const mockFetchPane = vi.mocked(fetchPane);
const mockSendKeys = vi.mocked(sendKeys);
const mockSendReply = vi.mocked(sendReply);

/** Where `❯` stands: on an option (0-2), on the field (3), on `Chat about this` (4). */
type Pointer = 0 | 1 | 2 | 3 | 4;

// A single AskUserQuestion in the 2.1.299 layout (fixtures claude--v2299-ask-field-single-*.txt): the
// field is row 4, ruled off from `Chat about this`, and the footer names ctrl+g while it is focused.
function ask(pointer: Pointer, text = "", question = "Which color do you prefer?"): string {
  const mark = (i: number) => (i === pointer ? "❯" : " ");
  const options = [
    ["Red", "A warm color"],
    ["Green", "A calm color"],
    ["Blue", "A cool color"],
  ] as const;
  return [
    "❯ Ask me which color I prefer.",
    "─".repeat(80),
    " ☐ Color ",
    "",
    question,
    "",
    ...options.flatMap(([label, description], i) => [`${mark(i)} ${i + 1}. ${label}`, `     ${description}`]),
    `${mark(3)} 4. ${text === "" ? "Type something." : text}`,
    "─".repeat(80),
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
});
