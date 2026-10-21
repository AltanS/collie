// Hermes's clarify panel, waiting for a choice (the input prompt reads `? ❯`), lifted into a
// `prompt-select` whose buttons send the choice's digit. Read from `_get_clarify_display_fragments`
// (hermes_cli/cli_tui_mixin.py, Hermes v0.22.2) and the hermes--clarify-* captures; the recipe is
// in CLARIFY_NOTES.md:
//
//     ╭─ Hermes Agent needs your input ────────────────╮   title: `{agent_name} needs your input`
//     │ 2 questions                                    │   header
//     │ ✓ Which colour for the badge?                  │   a locked question, then its answer
//     │     Green                                      │
//     │ ▸ Which size for the badge?                    │   the active question
//     │   ❯ 1. Small (Recommended)                     │   its choices; `❯` on the selected one
//     │     2. Large                                   │
//     │     3. Other (type your answer)                │   always last: opens a typed answer
//     │ · Which shape?                                 │   a question still to come
//     ╰────────────────────────────────────────────────╯
//
// A DIGIT LOCKS ITS CHOICE AT ONCE, with no Enter: live-probed, and
// `_tui_make_clarify_number_handler` in the source. The digit after the last choice is Other: it
// switches the panel to typed text (`✎ ❯`, the row reads `Other (type below)`), where the answer is
// typed into the input and the phone's own composer sends it, bound to that `✎ ❯` row (chrome.ts).
// That screen is not lifted: a digit there types a character into the answer.
//
// What stays raw: a multi-select question (`[ ]`/`[x]` rows, where a digit toggles and Enter
// submits); a panel Hermes clipped to fit a short terminal so that the active question's own row is
// off the top; and a panel any of whose rows this grammar cannot place.
//
// THE CLOCKS ARE NOT BOUND. The panel's text changes only when the dialog does. Everything under it
// (the spinner, the key hint with its countdown, the status bar, the input) ticks every second, so
// the bound region is the panel alone, and `bindTail` tells the bridge how far above the tail it ends
// (lib/tail-lines.ts). Issue #354 is what binding those rows did: every tap answered "changed".
//
// Pure; no pane access.

import type { StyledLine } from "../../blocks";
import type { PromptModel, PromptOption } from "../prompt-model";
import { tailLinesFor } from "../../tail-lines";
import { locateInput, type InputFrame } from "./chrome";
import {
  CLARIFY_HINT,
  isBlank,
  isPanelRow,
  PANEL_BOTTOM,
  PANEL_TOP,
  panelInterior,
  panelSubject,
  rowTexts,
  SPINNER_END,
} from "./markers";

export interface HermesDialogRegion {
  model: PromptModel;
  /** The panel's top row: the block starts there and the mirror keeps everything above. */
  startLine: number;
}

/** The panel located above the input frame, with the rows between them accounted for. */
export interface PanelSpan {
  top: number;
  bottom: number;
  /** Non-blank rows below the panel's bottom border, to the end of the buffer. */
  rowsBelow: number;
}

// Rows the spinner may take between a panel and its hint: one, wrapped onto more by a long question.
const MAX_SPINNER_ROWS = 4;
// A clarify panel holds at most five questions of five choices each (tools/clarify_tool.py), and
// Hermes clips it to the terminal. A bound against a stray box border far up the buffer.
const MAX_PANEL_ROWS = 80;

/**
 * The panel whose key hint matches `hint`, directly above the input frame's status slot, or null.
 * Shared with the approval grammar: the layout under a panel is the same for every modal.
 */
export function panelAboveInput(
  lines: StyledLine[],
  frame: InputFrame,
  hint: RegExp,
): PanelSpan | null {
  const texts = rowTexts(lines);
  // The key hint sits on the row above the status bar, or above the top rule when the operator has
  // turned the status bar off. Anything else between them (a subagent dock, a stash panel) is a
  // layout this grammar has not seen.
  const hintRow = (frame.statusRow ?? frame.topRule) - 1;
  if (hintRow < 0 || !hint.test(texts[hintRow]!)) return null;

  // Between the hint and the panel: the spinner, directly on the hint (wide panes only), then blank
  // rows. The spinner is one line that wraps onto at most a few rows; it opens two spaces in and,
  // while the panel's tool runs, ends in its timer group. Any other row there is a layout this
  // grammar has not seen, and the declared tail would vouch for it, so the panel is refused.
  let row = hintRow - 1;
  let spinnerTop = hintRow;
  while (row >= 0 && !isBlank(texts[row]!) && !PANEL_BOTTOM.test(texts[row]!)) {
    if (hintRow - row > MAX_SPINNER_ROWS) return null;
    spinnerTop = row--;
  }
  if (spinnerTop < hintRow) {
    if (!/^ {2}\S/.test(texts[spinnerTop]!)) return null;
    if (!SPINNER_END.test(texts.slice(spinnerTop, hintRow).join(""))) return null;
  }
  while (row >= 0 && isBlank(texts[row]!)) row--;
  if (row < 0 || !PANEL_BOTTOM.test(texts[row]!)) return null;
  const bottom = row;

  let top = -1;
  for (let i = bottom - 1; i >= Math.max(0, bottom - MAX_PANEL_ROWS); i--) {
    const t = texts[i]!;
    if (PANEL_TOP.test(t)) {
      top = i;
      break;
    }
    if (!isPanelRow(t)) return null;
  }
  if (top < 0) return null;

  // Nothing may sit under the input frame either (a completion menu, stray output): the declared
  // tail would count it.
  const frameEnd = frame.bottomRule ?? frame.lastInputRow;
  for (let i = frameEnd + 1; i < texts.length; i++) if (!isBlank(texts[i]!)) return null;
  let rowsBelow = 0;
  for (let i = bottom + 1; i <= frameEnd; i++) if (!isBlank(texts[i]!)) rowsBelow++;
  return { top, bottom, rowsBelow };
}

const TITLE = /^╭─ ([\s\S]+ needs your input) ─+╮$/;
const HEADER = /^\d+ questions?$/;
// A question's status row: ✓ locked, ▸ active, · still to come.
const STATUS = /^([✓▸·]) (\S[\s\S]*)$/;
// A choice row: two spaces, the pointer or a space, a space, then `N. label`. A checkbox (`[ ] `,
// `[x] `) after the pointer marks a multi-select question.
const CHOICE = /^ {2}([❯ ]) (\[[x ]\] )?(\d)\. (\S[\s\S]*)$/;
// Continuations: a wrapped question (indent 2), a locked answer (indent 4), a wrapped choice
// (indent 6). `_wrap_panel_text`'s `subsequent_indent` for each.
const QUESTION_MORE = /^ {2}\S/;
const ANSWER = /^ {4}\S/;
const CHOICE_MORE = /^ {6}\S/;
// The Other row's three faces (`clarify_other_*` in locales/en.yaml). Only the first is lifted.
// `Other (type below)` is the typed-answer screen. `Other: <earlier answer>` is a question revisited
// after an Other answer: its digit opens an EMPTY editor (the prefill comes only with Enter,
// `_clarify_batch_enter`), so a button labelled with the earlier answer would promise a resend.
const OTHER = "Other (type your answer)";
// What a question with no choices prints under itself while its typed answer is awaited
// (`clarify_guidance`, two spaces in).
const GUIDANCE = "  Type your answer in the prompt below, then press Enter.";

interface ParsedChoice {
  digit: string;
  label: string;
  pointed: boolean;
  checkbox: boolean;
  /** The panel row the choice starts on (for the pointer blank in `coreSignature`). */
  row: number;
}

interface ParsedQuestion {
  marker: string;
  text: string;
  /** The panel row of its status line. */
  row: number;
  choices: ParsedChoice[];
}

/** Walk the panel body. Null on any row this grammar cannot place. */
function parseBody(texts: string[], top: number, bottom: number): ParsedQuestion[] | null {
  const questions: ParsedQuestion[] = [];
  let mode: "question" | "answer" | "choice" | null = null;
  for (let i = top + 2; i < bottom; i++) {
    const row = panelInterior(texts[i]!);
    if (row === null) return null;
    const status = STATUS.exec(row);
    if (status !== null) {
      questions.push({ marker: status[1]!, text: status[2]!.trim(), row: i, choices: [] });
      mode = "question";
      continue;
    }
    const q = questions.at(-1);
    if (q === undefined) return null;
    if (q.marker === "▸" && row === GUIDANCE) {
      mode = null;
      continue;
    }
    if (q.marker === "▸") {
      const choice = CHOICE.exec(row);
      if (choice !== null) {
        q.choices.push({
          digit: choice[3]!,
          label: choice[4]!.trim(),
          pointed: choice[1] === "❯",
          checkbox: choice[2] !== undefined,
          row: i,
        });
        mode = "choice";
        continue;
      }
      if (mode === "choice" && CHOICE_MORE.test(row)) {
        const last = q.choices.at(-1)!;
        last.label = `${last.label} ${row.trim()}`;
        continue;
      }
    }
    if (q.marker === "✓" && (mode === "question" || mode === "answer") && ANSWER.test(row)) {
      mode = "answer";
      continue;
    }
    if (mode === "question" && QUESTION_MORE.test(row) && !ANSWER.test(row)) {
      q.text = `${q.text} ${row.trim()}`;
      continue;
    }
    return null;
  }
  return questions;
}

/** The clarify panel at the tail, waiting for a choice, as a `prompt-select`; or null. */
export function detectClarifyRegion(lines: StyledLine[]): HermesDialogRegion | null {
  const frame = locateInput(lines);
  if (frame === null || frame.state !== "clarify") return null;
  const span = panelAboveInput(lines, frame, CLARIFY_HINT);
  if (span === null) return null;
  const texts = rowTexts(lines);

  const title = TITLE.exec(texts[span.top]!);
  if (title === null) return null;
  const header = panelInterior(texts[span.top + 1]!);
  if (header === null || !HEADER.test(header)) return null;

  const questions = parseBody(texts, span.top, span.bottom);
  if (questions === null) return null;
  const active = questions.filter((q) => q.marker === "▸");
  if (active.length !== 1) return null;
  const q = active[0]!;
  const { choices } = q;

  // At least one choice and the Other row; digits 1..n in order; exactly one pointer; no checkbox.
  if (choices.length < 2) return null;
  if (choices.some((c, i) => c.digit !== String(i + 1) || c.checkbox)) return null;
  if (choices.filter((c) => c.pointed).length !== 1) return null;
  const other = choices.at(-1)!;
  if (other.label !== OTHER) return null;
  if (choices.slice(0, -1).some((c) => c.label.startsWith("Other "))) return null;

  const tail = tailLinesFor(span.rowsBelow);
  if (tail === null) return null;

  const panelRows = texts.slice(span.top, span.bottom + 1);
  const signature = panelRows.join("\n");
  // The pointer is the one glyph a digit tap does not need to agree on; blank it for identity.
  const pointerRows = new Set(choices.filter((c) => c.pointed).map((c) => c.row - span.top));
  const coreSignature = panelRows
    .map((t, i) => (pointerRows.has(i) ? t.replace("❯", " ") : t))
    .join("\n");

  const options: PromptOption[] = choices.map((c) => ({ label: c.label, keys: [c.digit] }));
  const model: PromptModel = {
    question: q.text,
    options,
    family: "select",
    caption: title[1]!,
    signature,
    coreSignature,
  };
  // What the card shows above the question when there is more than one: the header and every
  // question before the active one, locked answers included. Display only; `signature` covers them.
  if (questions.length > 1) model.subject = panelSubject(lines.slice(span.top + 1, q.row));
  if (tail !== undefined) model.bindTail = tail;
  return { model, startLine: span.top };
}
