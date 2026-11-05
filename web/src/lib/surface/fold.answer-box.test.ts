// A box that answers the agent's question (issue 704): omp's prompt-style answer editor, the box the
// `ask` tool opens for `Other (type your own)` and `n note`, read through the omp profile's own layout
// (`idle.frameAlternates`, `answers`, `submit`, `newlineSubmits`, `trailer.hint`). Before it the
// editor read `modal: unreadable`, `composer: unknown`, and only Type here reached it.
//
// The 18.16.0 captures came off herdr-core (`hc read` through the bridge's adapter), plain text; the
// older ones (18.4.4, 18.4.10) are styled. Each is read as captured and with its colour stripped.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseAnsi } from "../ansi";
import { splitLines } from "../blocks";
import { detectAskSelect } from "../harness/omp/ask";
import { agentOf, fixtureRows, idleFor, PANES_DIR, readScreen, rowsOf } from "../../test/surface-corpus";
import { FIXTURES, labelOf } from "../../test/surface-fold";
import { findInputFrame, readIsUnstyled } from "./frame";
import { stripSgr } from "./plain";
import { isFree } from "./surface";

const omp = idleFor("omp")!;
const raw = (name: string): string => readFileSync(join(PANES_DIR, name), "utf8");
const read = (text: string) => readScreen(rowsOf(text), agentOf("omp"), omp);

const BOXES: readonly (readonly [name: string, text: string, plain: boolean])[] = [
  ["omp--v18-16-0-custom-answer-empty--w200.txt", "", true],
  // The editor `Other` opened on the 18.16 glyph-keycap Ask (#703): glyph hint `⏎ or ⌃Q submit`, the box alone.
  ["omp--v18-16-0-answer-editor-empty--w200.txt", "", true],
  ["omp--v18-16-0-note-editor-empty--w200.txt", "", true],
  ["omp--v18-16-0-custom-answer-typed--w200.txt", "a ripe mango", true],
  [
    "omp--v18-16-0-custom-answer-wrapped--w200.txt",
    "a ripe mango from the market on the corner, the kind that smells sweet before you cut it, with a soft skin that gives a little under the thumb, and a stone you can chew around for the last of the flesh, eaten over the sink in July",
    true,
  ],
  ["omp--answer-editor-empty.txt", "", false],
  ["omp--answer-editor-typed.txt", "a deep teal, like the sea at dusk", false],
  ["omp--answer-editor-note.txt", "only if it is a warm blue", false],
  // 700 words on 37 rows: omp 18.4.4 grew the box with its answer.
  ["omp--answer-editor-long.txt", Array.from({ length: 700 }, (_, i) => `word${String(i).padStart(4, "0")}`).join(" "), false],
  [
    "omp--answer-editor-wrapped.txt",
    "a deep teal, like the sea at dusk — and here is a much longer continuation so that the custom answer editor has to soft wrap this text onto a second and maybe a third row of the box to see how it folds",
    false,
  ],
  ["omp--v18-4-ask-note-editor.txt", "", false],
];

describe("omp's answer editor is a box that answers the agent's question (#704)", () => {
  for (const [name, text, plain] of BOXES) {
    for (const styling of ["as captured", "unstyled"] as const) {
      it(`${name}, ${styling}: an idle box with no modal, holding the answer typed so far`, () => {
        const screen = styling === "unstyled" ? stripSgr(raw(name)) : raw(name);
        expect(readIsUnstyled(rowsOf(screen))).toBe(plain || styling === "unstyled");
        const { surface, frame, cues } = read(screen);
        expect(surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer: text === "" ? "empty" : "draft" });
        expect(frame?.interior.text).toBe(text);
        expect(frame?.placeholder).toBe(false);
        // The layout's own words: it answers a question, submits on Ctrl+Q (the key its hint names, and
        // the one that submits in both editor modes), and a line break would submit it.
        expect(frame).toMatchObject({ answers: true, submit: ["ctrl+q"], newlineSubmits: true });
        // The hint row inside the box is the box's own, never a dialog's footer.
        expect(frame?.hint).toEqual({ first: frame!.bottom - 2, last: frame!.bottom - 1 });
        expect(cues?.strength).toBe("none");
      });
    }
  }

  it("the empty box reads free: the protocol's answer rule, not the Surface, keeps other callers out", () => {
    expect(isFree(read(raw("omp--v18-16-0-custom-answer-empty--w200.txt")).surface)).toBe(true);
  });

  it("no other omp fixture is framed as a box that answers a question", () => {
    const answered = new Set(BOXES.map(([name]) => name));
    const others = FIXTURES.filter((name) => labelOf(name).harness === "omp" && !answered.has(name));
    expect(others.length).toBeGreaterThan(200);
    expect(others.filter((name) => findInputFrame(fixtureRows(name), omp)?.answers === true)).toEqual([]);
  });
});

// #703 + #704 on one dialog: omp 18.16 prints `⌥H hide`, the Ask reads as a card (#703), and the
// editor `Other` opens reads as a free box (#704). Both captures carry the same question.
describe("an omp 18.16 Ask, then the editor behind Other", () => {
  const ask = "omp--v18-16-0-ask-single-glyph-hide--w200.txt";
  const editor = "omp--v18-16-0-answer-editor-empty--w200.txt";

  it("the dialog reads as an ask with a card whose Other walks to the editor, and the editor reads free", () => {
    const dialog = read(raw(ask)).surface;
    expect(dialog.modal).toMatchObject({ ask: { channel: "keys" } });
    expect(isFree(dialog)).toBe(false);

    const model = detectAskSelect(splitLines(parseAnsi(raw(ask))));
    expect(model?.question).toBe("과일을 고르세요");
    const other = model?.options.find((option) => option.label === "Other (type your own)");
    expect(other?.keys).toEqual(["Down", "Down", "Down", "Enter"]);

    // Tapping Other presses that walk; the screen it reaches is the editor, titled with the same question.
    const opened = read(raw(editor));
    expect(raw(editor)).toContain(`Custom answer: ${model!.question}`);
    expect(opened.surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer: "empty" });
    expect(isFree(opened.surface)).toBe(true);
    expect(opened.frame).toMatchObject({ answers: true, submit: ["ctrl+q"], newlineSubmits: true });
  });
});

describe("what the answer layout does not take", () => {
  const empty = raw("omp--v18-16-0-custom-answer-empty--w200.txt");
  const typed = raw("omp--v18-16-0-custom-answer-typed--w200.txt");
  const swap = (screen: string, from: RegExp, to: string): string => screen.replace(from, to);

  // The hook-style editor, whose Enter inserts a newline, prints its submit keys joined with `/` and no ` or `.
  it("the hook-style editor's hint (`Ctrl+Q/Ctrl+Enter submit`) is no answer box, and stays a dialog", () => {
    const hook = swap(typed, /⏎ or Ctrl\+Q submit {2}⎋ cancel/u, "Ctrl+Q/Ctrl+Enter submit  Esc cancel");
    const { surface, frame } = read(hook);
    expect(frame?.answers).toBeUndefined();
    expect(surface.modal).toBe("unreadable");
    expect(isFree(surface)).toBe(false);
  });

  it("a title with no hint row under the answer is no box: the title alone never authorises typing", () => {
    const rows = empty.split("\n");
    const hint = rows.findIndex((row) => row.includes("submit"));
    const { surface, frame } = read([...rows.slice(0, hint), ...rows.slice(hint + 1)].join("\n"));
    expect(frame).toBeNull();
    expect(isFree(surface)).toBe(false);
  });

  it("a row other than the `> ` gutter where the answer starts is no box", () => {
    const { frame, surface } = read(swap(typed, /│ > a ripe mango/u, "│ ❯ a ripe mango"));
    expect(frame?.answers).toBeUndefined();
    expect(isFree(surface)).toBe(false);
  });

  it("a key-hint list typed into the answer reads as a dialog, never as a free box (fail closed)", () => {
    const quoted = swap(typed, /│ > a ripe mango {16}/u, "│ > ↑/↓ move · ⏎ select · ⎋ cancel");
    expect(read(quoted).surface.modal).not.toBe("none");
  });
});
