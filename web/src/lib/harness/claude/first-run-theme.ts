// The FIRST-RUN THEME STEP: the first screen Claude Code draws with an empty config folder, before
// the sign-in method list (login-methods.ts). Captured on Claude Code 2.1.325 (lab 2026-11-15,
// claude--v2325-first-run-theme-*.txt):
//
//     Welcome to Claude Code v2.1.325                   the welcome row, then the art (not below ~50 columns)
//     …the art…
//
//      Let's get started.                               the anchor, exactly
//
//      Choose the text style that looks best with your terminal      the question, may wrap
//      To change this later, run /theme                 one hint row
//
//          Auto (match terminal)                        seven unnumbered rows: a pointer column,
//      ❯ ✔ Dark mode                                    a check column (the saved choice), the label
//          Light mode
//          …
//          Light mode (ANSI colors only)
//
//      ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌               a diff preview in the pointed theme's colours
//       1  function greet() {
//       …
//      ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
//       Syntax theme: Monokai Extended (ctrl+t to disable)            the screen's last row (may wrap)
//
// No footer names a key, so ADR 0009 left it to the unread-dialog card, whose one button, Esc, does
// nothing here. MEASURED LIVE (Claude Code 2.1.325, empty CLAUDE_CONFIG_DIR, tmux, 2026-11-16):
//   * Down and Up move the pointer one row per press, and the list CLAMPS at both ends: Up on the
//     first row and Down on the last leave the pointer where it is. So `clampedEnds` is declared.
//   * Enter accepts the pointed row (settings.json then holds that theme) and opens the sign-in
//     method list.
//   * Moving the pointer re-colours the preview at once and rewrites its last row (`Syntax theme:
//     GitHub`, `ansi`, …), so the preview follows the pointer: it is left out of the identity.
//   * Digits, Tab and Esc do nothing. Home and End jump to the first and last rows, and j and k move
//     like Down and Up; neither is sent.
// So it lifts as a pointed list, the `/resume` and "Switch model?" recipe (ADR 0055, ADR 0058): a
// tap is the arrow walk from the `❯` plus Enter, and the action layer walks, verifies the pointer on
// the tapped row, and only then commits (ADR 0080). A stale tap is refused at entry, because the
// byte-faithful `signature` carries the pointer.
//
// Conservatism: the anchor row, the question's prefix, exactly these seven labels in this order with
// one pointer among them, the preview between two dashed rules ending on its `Syntax` row as the
// screen's last rows, and no input box. Anything short of that returns null and the screen stays the
// unread-dialog card. The card has no caption of its own: the screen names none. `/theme` inside a
// session draws the same list under a `Theme` title with a footer, and no `Let's get started.`, so it
// is not claimed here.
//
// Pure functions over parsed line text.

import type { StyledLine } from "../../blocks";
import { pointerWalk } from "../menu-hints";
import type { PromptModel, PromptOption } from "../prompt-model";
import { hasInputBox } from "./chrome";
import { isBlank, lineText } from "./markers";
import { coreRegionSignature, regionSignature, type PromptRegion } from "./prompt-select";

const ANCHOR = "Let's get started.";
const QUESTION_PREFIX = "Choose the text style";
/** The hint row under the question. */
const HINT_PREFIX = "To change this later";
/** The question may wrap: at 40 columns it takes two rows. */
const MAX_QUESTION_ROWS = 3;
/** The seven rows, in the order the screen draws them. */
export const THEME_LABELS: readonly string[] = [
  "Auto (match terminal)",
  "Dark mode",
  "Light mode",
  "Dark mode (colorblind-friendly)",
  "Light mode (colorblind-friendly)",
  "Dark mode (ANSI colors only)",
  "Light mode (ANSI colors only)",
];
/** An option row: one space, the pointer column, the check column, the label. */
const OPTION_ROW = /^ ([❯ ]) ([✔ ]) (\S.*)$/u;
/** The preview's dashed rule, one column in. */
const DASHED_RULE = /^ ╌{3,}$/u;
/** The preview's last row, after its second rule: `Syntax theme: …` or `Syntax highlighting disabled …`. */
const SYNTAX_ROW = /^ {1,2}Syntax /u;
/** Rows after the second rule: the `Syntax` row and the one row it wraps onto at 40 columns. */
const MAX_SYNTAX_ROWS = 2;
/** Rows between the two rules: the diff, wrapped at a narrow width. */
const MAX_PREVIEW_ROWS = 12;

/** The pointer row among the seven option rows from `first`, or null when they are not exactly the list. */
function pointedRow(texts: string[], first: number): number | null {
  let pointed: number | null = null;
  for (const [r, label] of THEME_LABELS.entries()) {
    const text = texts[first + r];
    if (text === undefined) return null;
    const match = OPTION_ROW.exec(text.trimEnd());
    if (match === null || match[3] !== label) return null;
    if (match[1] === "❯") {
      if (pointed !== null) return null;
      pointed = r;
    }
  }
  return pointed;
}

/** Whether the rows from `from` through `last` are the preview: blanks, a dashed rule, the diff, a
 *  second dashed rule, then the `Syntax` row (and its wrap) as the last. */
function previewThrough(texts: string[], from: number, last: number): boolean {
  let at = from;
  while (at <= last && isBlank(texts[at]!)) at++;
  if (at > last || !DASHED_RULE.test(texts[at]!.trimEnd())) return false;
  let second = at + 1;
  while (second <= last && !DASHED_RULE.test(texts[second]!.trimEnd())) second++;
  if (second > last || second - at - 1 > MAX_PREVIEW_ROWS || second - at - 1 === 0) return false;
  const syntax = second + 1;
  if (syntax > last || !SYNTAX_ROW.test(texts[syntax]!)) return false;
  // The `Syntax` row may wrap onto the row under it, with no blank row between.
  for (let i = syntax + 1; i <= last; i++) if (isBlank(texts[i]!)) return false;
  return last - syntax + 1 <= MAX_SYNTAX_ROWS;
}

/** The first-run theme step at the tail of `lines`, or null. */
export function detectFirstRunThemeRegion(lines: StyledLine[]): PromptRegion | null {
  const texts = lines.map(lineText);
  let last = texts.length - 1;
  while (last >= 0 && isBlank(texts[last]!)) last--;
  if (last < 0 || hasInputBox(lines)) return null;

  // The anchor, then the question right under it past one blank row.
  const anchor = texts.findIndex((t) => t.trim() === ANCHOR);
  if (anchor < 0 || texts.findIndex((t, i) => i > anchor && t.trim() === ANCHOR) >= 0) return null;
  let questionAt = anchor + 1;
  while (questionAt <= last && isBlank(texts[questionAt]!)) questionAt++;
  if (questionAt > last || !texts[questionAt]!.trim().startsWith(QUESTION_PREFIX)) return null;

  // The question's rows, then the one hint row, then a blank, then the seven options. The hint is
  // the row before the blank: the question is every row from its start to the hint.
  let blank = questionAt + 1;
  while (blank <= last && !isBlank(texts[blank]!)) blank++;
  const questionRows = blank - 1 - questionAt;
  if (questionRows < 1 || questionRows > MAX_QUESTION_ROWS || !texts[blank - 1]!.trim().startsWith(HINT_PREFIX)) return null;
  const firstOption = blank + 1;
  const pointed = pointedRow(texts, firstOption);
  if (pointed === null) return null;
  const lastOption = firstOption + THEME_LABELS.length - 1;
  if (!previewThrough(texts, lastOption + 1, last)) return null;

  const question = texts
    .slice(questionAt, questionAt + questionRows)
    .map((t) => t.trim())
    .join(" ");
  const options: PromptOption[] = THEME_LABELS.map((label, r) => ({ label, keys: pointerWalk(pointed, r) }));
  // The row the pointer stands on is the one a bare Enter takes: its badge is the terminal's own glyph.
  options[pointed] = { ...options[pointed]!, keyLabel: "❯" };

  const model: PromptModel = {
    question,
    options,
    family: "select",
    clampedEnds: true,
    // From the anchor through the screen's last row, pointer and preview included: a pointer moved
    // between the render and the tap refuses the tap at entry.
    signature: regionSignature(texts, anchor, last),
    // From the question through the last option, the pointer blanked. The preview below follows the
    // pointer (its colours and its `Syntax theme:` row), so it is not part of what this dialog is.
    coreSignature: coreRegionSignature(texts, questionAt, lastOption, new Set()),
    askRegion: regionSignature(texts, anchor, last),
  };
  return { model, startLine: anchor };
}
