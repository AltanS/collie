import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAnsi } from "../../ansi";
import { splitLines } from "../../blocks";
import { answerEditorDraft, locateAnswerEditor } from "./answer-editor";

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const typed = readFileSync(join(PANES_DIR, "omp--answer-editor-typed.txt"), "utf8");

// Replace the captured hint row (found by its stable word; the keys before it are theme glyphs).
const withHint = (hint: string) =>
  typed
    .split("\n")
    .map((row) => (row.includes(" submit") ? `${hint}\r` : row))
    .join("\n");
const lines = (screen: string) => splitLines(parseAnsi(screen));

describe("locateAnswerEditor declines what Enter would not submit", () => {
  it("finds the captured prompt-style editor", () => {
    expect(locateAnswerEditor(lines(typed))).not.toBeNull();
  });

  // hook-style HookEditorComponent: plain Enter inserts a newline, Ctrl+Q submits. A verified send
  // there would end in a stray newline instead of an answer.
  it("a hook-style hint (`⌃Q/⌃⏎ submit`) is not this editor", () => {
    expect(locateAnswerEditor(lines(withHint("│ ⏎ or ⌃Q submit  esc cancel │")))).not.toBeNull();
    const hookStyle = withHint("│ ⌃Q/⌃⏎ submit  esc cancel  ⌃G external editor │");
    expect(locateAnswerEditor(lines(hookStyle))).toBeNull();
  });

  it("no `> ` gutter means no prompt-style input row", () => {
    const noGutter = typed.replace("│\u001b[0m > ", "│\u001b[0m   ");
    expect(noGutter).not.toBe(typed);
    expect(locateAnswerEditor(lines(noGutter))).toBeNull();
  });

  it("anything painted under the box means the editor is not at the tail", () => {
    expect(locateAnswerEditor(lines(`${typed}\n some later output`))).toBeNull();
  });
});

// Every capture used the hardware cursor. With it off, omp paints `▏` after the last character, and
// a draft carrying it never matches what was typed, so every send would stall.
describe("answerEditorDraft with omp's software caret", () => {
  const empty = readFileSync(join(PANES_DIR, "omp--answer-editor-empty.txt"), "utf8");

  it("reads the answer without the caret after it", () => {
    const withCaret = typed.replace("dusk", "dusk▏");
    expect(withCaret).not.toBe(typed);
    expect(answerEditorDraft(lines(withCaret))).toBe("a deep teal, like the sea at dusk");
  });

  it("reads an editor holding only the caret as empty", () => {
    const withCaret = empty.replace("│\u001b[0m > ", "│\u001b[0m > ▏");
    expect(withCaret).not.toBe(empty);
    expect(answerEditorDraft(lines(withCaret))).toBeNull();
  });
});
