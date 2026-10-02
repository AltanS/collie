// omp's prompt-style ANSWER EDITOR — the free-text box the `ask` tool opens for `Other (type your
// own)` and for `n note`, and that `/goal` and `/review` reuse. Captured live (omp 18.4.4,
// 2026-10-01; omp--answer-editor-*.txt):
//
//   ╭─ Custom answer: Pick a colour ────────────────╮     title (`Note for Blue: …` for a note)
//   │                                               │
//   │ > a deep teal, like the sea at dusk — and …   │     first input row: the editor's `> ` gutter
//   │   of the box to see how it folds              │     soft-wrapped continuation, same indent
//   │                                               │
//   │ ⏎ or ⌃Q submit  esc cancel  ⌃G external editor │     the hint row
//   │                                               │
//   ╰───────────────────────────────────────────────╯
//
// It REPLACES omp's composer while it is open (extension-ui-controller clears the editor container
// and mounts only this), so a phone reply aimed at the pane belongs here, and Enter is what submits
// it. That is the whole reason this file exists: without it the reply pre-flight saw no composer,
// refused, and the operator's only way through was "type anyway", which typed the text but — the
// verify half having nothing to read either — withheld Enter and kept the draft on the phone.
//
// WHY ENTER IS SAFE HERE, and the one row that proves it. omp's HookEditorComponent has two modes
// (pi-tui overlays/hook-editor.ts): prompt-style, where plain Enter submits, and hook-style, where
// plain Enter inserts a NEWLINE and only Ctrl+Q / Ctrl+Enter submits. Collie's submit key is Enter,
// so recognising a hook-style editor would make every verified send land a stray newline instead of
// an answer. The two modes paint different hint rows — prompt-style `<enter> or <follow-up> submit`,
// hook-style `<k>/<k> submit` — and prompt-style alone sets the `> ` gutter. Both are required.
//
// WHY A NEWLINE IN THE MESSAGE IS NOT. In prompt-style, a raw LF is "any plain Enter encoding" and
// submits too, and `pane.send_text` delivers `\n` as a real keypress (HERDR_API.md). Live-probed:
// typing `line one\nline two` into this box submitted `line one` as the answer and sent `line two`
// on to the composer behind it. So the adapter reports this screen through `newlineSubmits`, and the
// reply path refuses a multi-line message here rather than splitting it.
//
// WHY THE PRE-CLEAR SWEEP IS SAFE TOO. A draft read here can arm composer.tsx's `ctrl+k` + Backspace
// sweep, which the bridge binds to `answerEditorPrompt`'s row.
// Prompt-style input forwards both to pi-tui's `Editor`: `ctrl+k` is `tui.editor.deleteToLineEnd`,
// and Backspace deletes one character. Neither is a submit, cancel or app key in this widget.
//
// Conservatism contract, same as chrome.ts: every step can only reject, the title is never read, the
// answer text never decides the match, and anything short of the full shape at the tail returns null.

import type { StyledLine } from "../../blocks";
import { isBlank, lineText, rstrip } from "./markers";

/** The editor located at the buffer's tail. Every index is into the ORIGINAL `lines` array. */
export interface AnswerEditor {
  /** The `│ > …│` row: the first visual row of the answer. */
  firstInputRow: number;
  /** The last visual row of the answer (equals `firstInputRow` when it fits on one row). */
  lastInputRow: number;
}

/** Closed corner to corner — omp's ordinary box bottom, unlike the composer's `╰─ … ─╯`. */
const BOX_BOTTOM = /^╰─+╯$/;
/** A body row with nothing between its sides. */
const BODY_BLANK = /^│\s*│$/;
/** Any body row of the box. `[\s\S]`, never `.`: see markers.ts on U+2028/U+2029. */
const BODY_ROW = /^│[\s\S]*│$/;
/** The title row: the title is inset into the top border. Content is never read. */
const BOX_TOP = /^╭─[\s\S]*╮$/;

// The prompt-style hint. `<enter> or <follow-up> submit` is built only on the prompt-style branch of
// HookEditorComponent; hook-style joins its submit keys with `/`, so " or " in front of "submit" is
// what pins the mode in which plain Enter submits. Each key is whatever the user's symbol preset
// renders (a nerd-font glyph, `⏎`, `Enter`, `⌃Q`, `Ctrl+Q` …), so the keys are matched as opaque
// non-empty runs. Nothing after `submit` is required: a narrow pane may truncate the rest.
const PROMPT_HINT = /^│ \S[\s\S]*? or \S[\s\S]*? submit(?:\s|$)/;

/** The first answer row: omp's `setPromptGutter("> ")` inside the box's one-column inset. */
const INPUT_FIRST = /^│ > ([\s\S]*?)\s*│$/;
/** A continuation row: the gutter's width in spaces. A blank one is an empty line of the answer. */
const INPUT_CONT = /^│ {3}([\s\S]*?)\s*│$/;

// Rows between the title and the answer: one spacer, plus `detail` lines when omp's title carries
// a second line (hook-editor.ts renders title lines after the first as body rows). Generous — this
// bounds a walk, it does not discriminate.
const MAX_HEADER_ROWS = 16;
// The answer's own rows. The box grows with the answer: a 700-word answer drew 37 rows
// (omp--answer-editor-long.txt). The bound only has to cover the bridge's read tail, 200 rows by
// default; an answer taller than that has no first row on screen and is declined.
const MAX_INPUT_ROWS = 200;

// omp's SOFTWARE caret, painted after the answer's last character when the operator has turned the
// hardware cursor off (`symbols.inputCursor`, pi-tui theme/tui-adapters.ts). It is not part of the
// answer, and left in it fails the verify match on every send. Dropped only at the end of the last
// row, where the caret sits after typing. The ASCII preset's caret is `|`, which an answer can end in
// too, so it is kept: that send stalls with the draft on the phone, the fail-closed direction.
const SOFTWARE_CARET = /▏$/;

/**
 * Locate omp's prompt-style answer editor at the tail of `lines`, or null. Bottom-up:
 *
 *   ╰────╯              the last non-blank row
 *   │    │              one blank body row
 *   │ <hint> │          the PROMPT-STYLE hint (`… or … submit`)
 *   │    │              one blank body row
 *   │   <cont…> │       0..MAX_INPUT_ROWS continuation rows
 *   │ > <answer> │      the first input row
 *   │ <header…> │       1..MAX_HEADER_ROWS body rows (spacer, detail lines)
 *   ╭─ <title> ─╮       the title border
 */
export function locateAnswerEditor(lines: StyledLine[]): AnswerEditor | null {
  const texts = lines.map((l) => rstrip(lineText(l)));
  let row = texts.length - 1;
  while (row >= 0 && isBlank(texts[row]!)) row--;
  if (row < 3) return null;

  if (!BOX_BOTTOM.test(texts[row]!)) return null;
  if (!BODY_BLANK.test(texts[row - 1]!)) return null;
  if (!PROMPT_HINT.test(texts[row - 2]!)) return null;
  if (!BODY_BLANK.test(texts[row - 3]!)) return null;

  const lastInputRow = row - 4;
  let first = lastInputRow;
  while (first >= 0 && lastInputRow - first < MAX_INPUT_ROWS && !INPUT_FIRST.test(texts[first]!)) {
    if (!INPUT_CONT.test(texts[first]!)) return null;
    first--;
  }
  if (first < 0 || !INPUT_FIRST.test(texts[first]!)) return null;

  let top = first - 1;
  while (top >= 0 && first - top <= MAX_HEADER_ROWS && BODY_ROW.test(texts[top]!)) top--;
  // At least the spacer row sits between the title and the answer.
  if (top < 0 || top === first - 1 || !BOX_TOP.test(texts[top]!)) return null;

  return { firstInputRow: first, lastInputRow };
}

/**
 * The answer typed so far, rows folded with one space (omp wraps at word boundaries), or null when
 * the editor is empty or not on screen. This is the verify half of the reply guard on this screen:
 * the submit key waits until it contains what was typed.
 */
export function answerEditorDraft(lines: StyledLine[]): string | null {
  const editor = locateAnswerEditor(lines);
  if (editor === null) return null;
  const parts: string[] = [];
  for (let i = editor.firstInputRow; i <= editor.lastInputRow; i++) {
    const text = rstrip(lineText(lines[i]!));
    const m = (i === editor.firstInputRow ? INPUT_FIRST : INPUT_CONT).exec(text);
    const part = m![1]!.trim();
    parts.push(i === editor.lastInputRow ? part.replace(SOFTWARE_CARET, "").trimEnd() : part);
  }
  const draft = parts.filter((p) => p.length > 0).join(" ");
  return draft.length === 0 ? null : draft;
}

/**
 * The binding region for the pre-clear sweep: the answer's LAST row, verbatim. It is the row the
 * caret ends on, and it sits four non-blank rows above the tail (spacer, hint, spacer, border), so it
 * is always inside the bridge's six-row window however long the answer grows.
 */
export function answerEditorPrompt(lines: StyledLine[]): string | null {
  const editor = locateAnswerEditor(lines);
  if (editor === null) return null;
  const row = rstrip(lineText(lines[editor.lastInputRow]!));
  return row.length === 0 ? null : row;
}
