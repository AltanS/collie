// The opencode QUESTION dialog — the Tier-2 lift for the `question` tool (issue 329). The agent asks
// the person a question with a list of answers, and opencode paints it in its own bar run at the
// buffer's tail, in place of the whole composer (no model row, no rule, no status rows). Measured on
// opencode 1.18.33, 2026-10-01; the ground truth is QUESTION_NOTES.md beside this file, pinned by
// `web/src/fixtures/panes/oc--question--*.txt`.
//
//     ┃                                     <- a bare bar row (padding)
//     ┃  Which colour?                      <- the question (the header is NOT drawn)
//     ┃
//     ┃  1. Red                             <- one chip on the pointed row's `N. label` run
//     ┃     warm                            <- a description, unnumbered, indented under its label
//     ┃  2. Green
//     ┃     calm
//     ┃  4. Type your own answer            <- always the LAST numbered row; not an option
//     ┃                                     <- (opened: one input row under it, `Type your own answer`
//     ┃                                     <-  as the placeholder, or what was typed)
//     ┃  ↑↓ select  enter submit  esc dismiss
//     ┃                                     <- a bare bar row, then the buffer's end
//
// WHAT LIFTS: one question, single select, up to nine options. Each option's keys are its own DIGIT,
// alone: the digit submits at once, ignores the pointer, and the screen printed it (QUESTION_NOTES.md,
// "The recipe"). That is the same rule Claude's wizard follows, and ADR 0009 forbids only a digit the
// screen did NOT print. A two-digit number has no single key, so a tenth option stays raw.
//
// WHAT REFUSES (null, so the raw mirror and the unread-dialog card with Escape cover it, ADR 0053):
//   * a TAB BAR (`⇆ tab` in the footer): a multi select, two or more questions, the Confirm tab. A
//     digit there is a different key on each tab, so those dialogs have their own grammar in
//     `question-tabs.ts`, which reads the same rows with the helpers exported below.
//   * more than nine options, a pointer that cannot be told, a numbering that does not run 1..n.
//
// The pointer is a BACKGROUND chip on the `N. label` run, read RELATIVE to the footer's own
// background, never by colour name (the permission lift reads its chips the same way). The pointer
// does NOT always start on option 1 (QUESTION_NOTES.md), and a digit ignores it, so it never reaches
// a key. It is still read: zero or two chips means the screen is not one this module understands.
//
// Collie never types into the free-text row. `submitPromptFeedback` refuses a `free-text` row, and
// that is intended. The row is modelled so that, while its input is OPEN (a row under it holds the
// placeholder or the typed text), the card locks every button: the dialog routes digits into the
// input as text there.

import type { StyledLine } from "../../blocks";
import type { PromptFeedback, PromptModel, PromptOption } from "../prompt-model";
import { backgroundOf } from "./dialog";
import { FREE_TEXT_LABEL, barDraftText, isBareBar, isBarRow, isBlank, lineText, questionFooter, rstrip } from "./markers";

// How far above the footer the dialog may start. Nine options with descriptions need 22 rows from
// the first text row to the footer (QUESTION_NOTES.md, "Height"); a few more for a wrapped question.
const MAX_REGION_ROWS = 24;

// A numbered row's interior: `1. Red`, `10. Ten`.
const NUMBERED = /^(\d+)\. (.+)$/;

/** The detected dialog: the model, `startLine` (the first row the block REPLACES: the question's
 *  first row), and `pointed`, the numbered row the pointer chip sits on (1-based, the free-text row
 *  included). `pointed` is read, never sent: a digit ignores the pointer. */
export interface QuestionRegion {
  model: PromptModel;
  startLine: number;
  pointed: number;
}

/**
 * Detect a question dialog at the tail of `lines`, or null. Pure. Every step can only REJECT.
 */
export function detectQuestionDialog(lines: StyledLine[]): QuestionRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));

  // 1. The footer anchor: a bar row ending `enter submit|toggle|confirm  esc dismiss`, at the tail.
  const footer = locateFooter(texts);
  if (footer < 0) return null;

  // 2. Which dialog. Only `↑↓ select  enter submit` with NO tab bar is a single question, single
  //    select. Everything else (multi select, several questions, the Confirm tab) stays raw.
  const kind = questionFooter(texts[footer]!)!;
  if (kind.verb !== "submit" || kind.tabs || !kind.list) return null;

  // The background the footer is painted on is the base every row but the pointer sits on.
  const base = footerBackground(lines[footer]!, texts[footer]!);
  if (base === null) return null;

  // 3. The numbered rows, walked UP from the footer. One bare bar row sits between the list and the
  //    footer; each numbered row owns the unnumbered, indented rows under it.
  const entries = walkEntries(texts, footer, Math.max(0, footer - MAX_REGION_ROWS));
  if (entries === null) return null;
  const firstOption = entries[0]!.row;

  // 4. The free-text row: the last numbered row, when it carries opencode's own label. It is not an
  //    option. Without it (a call that turns the custom answer off, not measured) every row is one.
  const last = entries[entries.length - 1]!;
  const freeText = last.label === FREE_TEXT_LABEL ? last : null;
  const choices = freeText === null ? entries : entries.slice(0, -1);
  if (choices.length === 0 || choices.length > MAX_OPTIONS) return null;
  // No other row may be the free-text label: that would be an option the digit cannot tell apart.
  if (choices.some((e) => e.label === FREE_TEXT_LABEL)) return null;

  // 5. The pointer: exactly one numbered row whose `N.` run is on another background than the
  //    footer's. Zero or two: refuse rather than guess what a tap would do.
  const pointed = pointedEntry(lines, texts, entries, base);
  if (pointed < 0) return null;

  // 6. The question: the paragraph of bar rows above the first option. Walk up over the bare bar
  //    row between them (a single select has one, a multi select none), then take the run of
  //    gutter-aligned text rows. A narrow pane wraps it, so the rows join with one space.
  let q = firstOption - 1;
  while (q >= 0 && isBareBar(texts[q]!)) q--;
  const paragraphEnd = q;
  const parts: string[] = [];
  while (q >= 0 && firstOption - q <= MAX_REGION_ROWS) {
    const inner = isBarRow(texts[q]!) ? barDraftText(texts[q]!) : null;
    if (inner === null || inner.trim().length === 0 || inner.startsWith(" ")) break;
    parts.unshift(inner.trim());
    q--;
  }
  if (parts.length === 0) return null;
  const startLine = paragraphEnd - parts.length + 1;
  // The paragraph sits under one bare bar row (the dialog's top padding) and nothing but the
  // transcript above that. A TEXT bar row in its place is a tab bar or another dialog's body.
  if (q < 0 || !isBareBar(texts[q]!)) return null;
  if (q - 1 >= 0 && isBarRow(texts[q - 1]!) && !isBareBar(texts[q - 1]!)) return null;

  // 7. The free-text row's state. Opened, a row under it holds the placeholder or the typed text,
  //    the chip stays on the row, and every digit becomes text. The pointer on any other row with
  //    sub-rows under the free-text row is not a shape we know.
  let feedback: PromptFeedback | undefined;
  let inputRows: number[] = [];
  if (freeText !== null) {
    const open = freeText.sub.length > 0;
    if (open && pointed !== freeText.n) return null;
    const typed = freeText.sub.join(" ");
    feedback = {
      key: String(freeText.n),
      focused: open,
      text: typed === FREE_TEXT_LABEL ? "" : typed,
      purpose: "free-text",
    };
    if (open) inputRows = rowsAfter(freeText.row, freeText.sub.length);
  }

  const options: PromptOption[] = choices.map((e) => {
    const option: PromptOption = { label: e.label, keys: [String(e.n)] };
    if (e.sub.length > 0) option.description = e.sub.join(" ");
    return option;
  });

  // The dialog's own rows from the question to the footer, byte-faithful: the bridge binds the first
  // write to this text. It ends at the footer, inside the bridge's tail window. The pointer is a
  // STYLE, never text, so a moved chip leaves it as it was, and a digit does not care where the
  // chip is. A toggled or typed row IS text, so those change it.
  const signature = texts.slice(startLine, footer + 1).join("\n");
  // The identity the free-text flow would compare mid-flight: the same rows without the input row.
  const core = texts.slice(startLine, footer + 1).filter((_, i) => !inputRows.includes(startLine + i));
  const model: PromptModel = {
    question: parts.join(" "),
    options,
    family: "select",
    signature,
    coreSignature: core.join("\n"),
  };
  if (feedback !== undefined) model.feedback = feedback;
  return { model, startLine, pointed };
}

/** The `count` rows right under `row`. */
function rowsAfter(row: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => row + 1 + i);
}

// ---------------------------------------------------------------------------------------------
// Shared with question-tabs.ts: the row walks and the style reads every question dialog has in
// common. Each returns "nothing" (null or -1) when the screen is not the shape, and none of them
// decides which dialog it is: the caller reads the footer's verb for that.
// ---------------------------------------------------------------------------------------------

/** The most options one digit can reach. The free-text row is not counted. */
export const MAX_OPTIONS = 9;

/** A numbered row and the rows hung under it. */
export interface Entry {
  row: number;
  n: number;
  label: string;
  /** The unnumbered sub-rows under the label, trimmed. */
  sub: string[];
}

/**
 * The footer row: the last row carrying a question footer, with at most TWO non-blank rows under it
 * (the bare bar rows), so ordinary output appended below pushes the footer out of the window and
 * the lift refuses. -1 when there is none.
 */
export function locateFooter(texts: string[]): number {
  let nonBlankBelow = 0;
  for (let i = texts.length - 1; i >= 0; i--) {
    if (isBlank(texts[i]!)) continue;
    if (questionFooter(texts[i]!) !== null) return i;
    nonBlankBelow++;
    if (nonBlankBelow > 2) return -1;
  }
  return -1;
}

/**
 * The numbered rows above `footer`, walked UP no further than `top`, each with the unnumbered,
 * indented rows hung under it. Null unless there is at least one, no sub-row dangles above the
 * first, and the numbering runs 1..n with nothing missing (a bare row inside the list, an option
 * with an empty description that was not measured, ends the walk early and fails this, which is
 * the point).
 */
export function walkEntries(texts: string[], footer: number, top: number): Entry[] | null {
  let at = footer - 1;
  while (at >= 0 && isBareBar(texts[at]!)) at--;
  const entries: Entry[] = [];
  let pending: string[] = [];
  for (; at >= top; at--) {
    const inner = barDraftText(texts[at]!);
    if (inner === null) break;
    const numbered = NUMBERED.exec(inner);
    if (numbered !== null) {
      entries.unshift({ row: at, n: Number(numbered[1]), label: numbered[2]!.trim(), sub: pending });
      pending = [];
      continue;
    }
    // A description or the open input: an indented, non-blank row. Anything else ends the list.
    if (!inner.startsWith("   ") || inner.trim().length === 0) break;
    pending.unshift(inner.trim());
  }
  // Sub-rows with no numbered row above them are not a list (a torn frame, or foreign output).
  if (pending.length > 0 || entries.length === 0) return null;
  if (!entries.every((e, i) => e.n === i + 1)) return null;
  return entries;
}

/**
 * The pointer: the one numbered row whose `N.` run sits on another background than `base`, the
 * footer's own. Its `n`, or -1 when no row or two rows carry a chip.
 */
export function pointedEntry(lines: StyledLine[], texts: string[], entries: Entry[], base: string): number {
  let pointed = -1;
  for (const e of entries) {
    const text = texts[e.row]!;
    const digit = `${e.n}.`;
    const start = text.indexOf(digit);
    const bg = backgroundOf(lines[e.row]!, start, start + digit.length) ?? "";
    if (bg === base) continue;
    if (pointed >= 0) return -1;
    pointed = e.n;
  }
  return pointed;
}

/** The background the footer's `esc dismiss` hint is painted on, as a comparable key ("" when the
 *  hint carries none), or null when the row carries no such hint. */
export function footerBackground(line: StyledLine, text: string): string | null {
  const at = text.lastIndexOf("esc dismiss");
  if (at < 0) return null;
  return backgroundOf(line, at, at + "esc".length) ?? "";
}

/** The two foregrounds the footer paints its hints in: `bright` is the key word (`esc`), `grey` the
 *  verb after it (`dismiss`). The dialogs use the pair to say a tab holds an answer or does not,
 *  and a committed free-text row from an open one. Compared, never named. */
export interface FooterInks {
  bright: string;
  grey: string;
}

/** The footer's ink pair, or null when the row has no `esc dismiss`, either word is painted in more
 *  than one foreground, or the two are the same (a theme where they cannot be told apart). */
export function footerInks(line: StyledLine, text: string): FooterInks | null {
  const at = text.lastIndexOf("esc dismiss");
  if (at < 0) return null;
  const bright = foregroundOf(line, at, at + "esc".length);
  const grey = foregroundOf(line, at + "esc ".length, at + "esc dismiss".length);
  if (bright === null || grey === null || bright === grey) return null;
  return { bright, grey };
}

/** The foreground shared by every visible cell of [start, end) on `line` ("" when unpainted), or
 *  null when the cells disagree or there is none. */
export function foregroundOf(line: StyledLine, start: number, end: number): string | null {
  let at = 0;
  let found: string | null = null;
  for (const seg of line.segments) {
    const from = Math.max(at, start);
    const to = Math.min(at + seg.text.length, end);
    if (to > from && seg.text.slice(from - at, to - at).trim().length > 0) {
      const fg = seg.fg ?? "";
      if (found !== null && found !== fg) return null;
      found = fg;
    }
    at += seg.text.length;
    if (at >= end) break;
  }
  return found;
}
