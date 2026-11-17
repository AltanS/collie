// The SIGN-IN METHOD PICKER of `/login` — the numbered list Claude Code shows before it opens the
// sign-in address. Captured on Claude Code 2.1.325 (lab, 2026-11-15, claude--v2325-login-*.txt):
//
//     ─────────────────────────────────────────────    the modal's rule, as wide as the pane
//       Login                                           the title, exactly "Login"
//
//       Claude Code can be used with your Claude …      (only on the first list)
//
//       Select login method:                            the question: ends in ":" or "?"
//
//       ❯ 1. Claude account with subscription · …       numbered rows; a long label wraps under it
//            or Enterprise
//         2. Anthropic Console account · API usage …
//
//       Esc to cancel                                    the whole footer
//
// Older builds opened this picker under the `▔` modal edge, and the generic menu grammar (menu.ts)
// lifted it with Up, Down and Cancel. 2.1.325 draws a `─` rule instead, so nothing claimed it and the
// phone showed the raw rows. A menu card with only arrows also had no way to choose: the footer names
// no Enter. Here a digit alone chooses, measured live on 2.1.325: `2` on the first list opened the
// Console list at once, and `1` there opened the sign-in address. So it lifts as a single-choice card
// whose buttons press that digit, the codex recipe (an option's own `keys` win over the family's).
//
// Conservatism: the footer must be the whole last row, the title must read "Login" under a rule as
// wide as the rows below it, the numbered rows must run 1..n right over the footer, and no input box
// may be on screen. Anything short of that returns null and the screen stays as it was.
//
// THE FIRST RUN draws the same lists with none of that frame (Claude Code 2.1.325 with an empty config
// folder, lab 2026-11-15, claude--v2325-first-run-*.txt): no rule, no `Login`, no footer, and Esc does
// nothing there. The list stands at the very end of the screen, under the welcome art:
//
//     Welcome to Claude Code v2.1.325                  row 0, the only anchor below ~50 columns
//     …the art…
//     .......█ █   █ █...............                  the art's dotted last row
//
//      Claude Code can be used with your Claude …
//
//      Select login method:                            the question: ends in ":" or "?"
//
//      ❯ 1. Claude account with subscription · …       numbered rows, the last row of the screen is
//           Enterprise                                 the last option or its wrapped label
//        2. Anthropic Console account · …
//
// A digit chooses there too (measured: `1`, `2` and `3` each acted at once). It is the second accepted
// shape of the same card: the anchor row stands in for the rule and title, the screen's end for the
// footer, and a wrapped label must follow its option with no blank row. The card has no caption of
// its own there: the screen names none. The third-party list (`Using 3rd-party platforms`) asks no
// question and has a row under its options, so it is not lifted.
//
// Pure functions over parsed line text.

import type { StyledLine } from "../../blocks";
import { displayWidth } from "../../text-width";
import type { PromptModel, PromptOption } from "../prompt-model";
import { hasInputBox } from "./chrome";
import { isBlank, isHorizontalRule, lineText } from "./markers";
import { coreRegionSignature, parseOptionRow, regionSignature, trailingMenuRows } from "./prompt-select";

const TITLE = "Login";
const FOOTER = "Esc to cancel";
/** How far above the footer the rule may sit: the first list is 16 rows tall at 61 columns. */
const RULE_WINDOW = 30;
/** A question ends the way Claude's own do. */
const QUESTION = /[:?]$/u;

/** The picker found at the tail: its card and the rule it starts on. */
export interface LoginMethodsRegion {
  model: PromptModel;
  startLine: number;
}

/** The first run's anchor: the welcome row, or the art's dotted last row (claude.json's first-run field, too). */
const FIRST_RUN_ANCHOR = /^(?:Welcome to Claude Code v\S+|\.{3,}█.*\.{3,})$/u;
/** A wrapped label's rows on the first run stand further in than the option's number. */
const WRAP_INDENT = 4;

/** The numbered rows of a list from `from` to `to` (exclusive), 1..n at its end, with every row in it numbered. */
function menuRowsIn(texts: string[], from: number, to: number): { index: number; n: number; label: string }[] | null {
  const rows: { index: number; n: number; label: string }[] = [];
  for (let i = from; i < to; i++) {
    const parsed = parseOptionRow(texts[i]!);
    if (parsed !== null) rows.push({ index: i, ...parsed });
  }
  const menu = trailingMenuRows(rows);
  if (menu.length < 2 || menu.length > 9 || menu.length !== rows.length) return null;
  return menu;
}

/** The question over the first option: the nearest row above it that is not blank, ending in ":" or "?". */
function questionAbove(texts: string[], firstOpt: number, floor: number): number | null {
  let at = firstOpt - 1;
  while (at > floor && isBlank(texts[at]!)) at--;
  return at > floor && QUESTION.test(texts[at]!.trim()) ? at : null;
}

/** The card's options: each numbered row with the rows of its wrapped label, up to `end` (exclusive). */
function optionsOf(texts: string[], menu: readonly { index: number; n: number; label: string }[], end: number): PromptOption[] {
  return menu.map((row, r) => {
    const to = r + 1 < menu.length ? menu[r + 1]!.index : end;
    const wrapped: string[] = [];
    for (let i = row.index + 1; i < to; i++) if (!isBlank(texts[i]!)) wrapped.push(texts[i]!.trim());
    return { label: [row.label, ...wrapped].join(" "), keys: [String(row.n)] };
  });
}

/** The `/login` shape: a rule, `Login`, the list, `Esc to cancel` as the last row. */
function loginModal(texts: string[], fi: number): LoginMethodsRegion | null {
  if (texts[fi]!.trim() !== FOOTER) return null;
  // The rule: the nearest rule row above the footer, as wide as every row under it.
  let top = fi - 1;
  while (top >= 0 && fi - top <= RULE_WINDOW && !isHorizontalRule(texts[top]!)) top--;
  if (top < 0 || fi - top > RULE_WINDOW) return null;
  const width = displayWidth(texts[top]!.trimEnd());
  for (let i = top + 1; i < fi; i++) if (displayWidth(texts[i]!.trimEnd()) > width) return null;
  let titleAt = top + 1;
  while (titleAt < fi && isBlank(texts[titleAt]!)) titleAt++;
  if (titleAt >= fi || texts[titleAt]!.trim() !== TITLE) return null;

  // The numbered rows: a run 1..n with nothing under the last one but its wrapped label and blanks.
  const menu = menuRowsIn(texts, titleAt + 1, fi);
  if (menu === null) return null;
  const questionAt = questionAbove(texts, menu[0]!.index, titleAt);
  if (questionAt === null) return null;
  const model: PromptModel = {
    question: texts[questionAt]!.trim(),
    options: optionsOf(texts, menu, fi),
    family: "select",
    caption: TITLE,
    signature: regionSignature(texts, top, fi),
    coreSignature: coreRegionSignature(texts, questionAt, fi, new Set()),
    askRegion: regionSignature(texts, top, fi),
  };
  return { model, startLine: top };
}

/** The first-run shape: the welcome anchor, then the list as the screen's last rows. */
function firstRun(texts: string[], fi: number): LoginMethodsRegion | null {
  let anchor = fi - 1;
  while (anchor >= 0 && fi - anchor <= RULE_WINDOW && !FIRST_RUN_ANCHOR.test(texts[anchor]!.trimEnd())) anchor--;
  if (anchor < 0 || fi - anchor > RULE_WINDOW) return null;
  const menu = menuRowsIn(texts, anchor + 1, fi + 1);
  if (menu === null) return null;
  // Under each option only its wrapped label, straight under it, further in than its number.
  for (const [r, row] of menu.entries()) {
    const to = r + 1 < menu.length ? menu[r + 1]!.index : fi + 1;
    let i = row.index + 1;
    while (i < to && !isBlank(texts[i]!) && texts[i]!.length - texts[i]!.trimStart().length >= WRAP_INDENT) i++;
    while (i < to && isBlank(texts[i]!)) i++;
    if (i < to) return null;
  }
  const questionAt = questionAbove(texts, menu[0]!.index, anchor);
  if (questionAt === null) return null;
  let start = anchor + 1;
  while (start < questionAt && isBlank(texts[start]!)) start++;
  const model: PromptModel = {
    question: texts[questionAt]!.trim(),
    options: optionsOf(texts, menu, fi + 1),
    family: "select",
    signature: regionSignature(texts, start, fi),
    coreSignature: coreRegionSignature(texts, questionAt, fi, new Set()),
    askRegion: regionSignature(texts, start, fi),
  };
  return { model, startLine: start };
}

/** The sign-in method picker at the tail of `lines`, or null. */
export function detectLoginMethodsRegion(lines: StyledLine[]): LoginMethodsRegion | null {
  const texts = lines.map(lineText);
  let fi = texts.length - 1;
  while (fi >= 0 && isBlank(texts[fi]!)) fi--;
  if (fi < 0 || hasInputBox(lines)) return null;
  return loginModal(texts, fi) ?? firstRun(texts, fi);
}
