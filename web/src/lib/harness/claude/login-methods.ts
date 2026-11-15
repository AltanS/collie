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

/** The sign-in method picker at the tail of `lines`, or null. */
export function detectLoginMethodsRegion(lines: StyledLine[]): LoginMethodsRegion | null {
  const texts = lines.map(lineText);
  let fi = texts.length - 1;
  while (fi >= 0 && isBlank(texts[fi]!)) fi--;
  if (fi < 0 || texts[fi]!.trim() !== FOOTER) return null;
  if (hasInputBox(lines)) return null;

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
  const rows: { index: number; n: number; label: string }[] = [];
  for (let i = titleAt + 1; i < fi; i++) {
    const parsed = parseOptionRow(texts[i]!);
    if (parsed !== null) rows.push({ index: i, ...parsed });
  }
  const menu = trailingMenuRows(rows);
  if (menu.length < 2 || menu.length > 9 || menu.length !== rows.length) return null;
  const firstOpt = menu[0]!.index;
  let questionAt = firstOpt - 1;
  while (questionAt > titleAt && isBlank(texts[questionAt]!)) questionAt--;
  if (questionAt <= titleAt || !QUESTION.test(texts[questionAt]!.trim())) return null;

  const options: PromptOption[] = [];
  for (let r = 0; r < menu.length; r++) {
    const row = menu[r]!;
    const end = r + 1 < menu.length ? menu[r + 1]!.index : fi;
    const wrapped: string[] = [];
    for (let i = row.index + 1; i < end; i++) if (!isBlank(texts[i]!)) wrapped.push(texts[i]!.trim());
    options.push({ label: [row.label, ...wrapped].join(" "), keys: [String(row.n)] });
  }
  const model: PromptModel = {
    question: texts[questionAt]!.trim(),
    options,
    family: "select",
    caption: TITLE,
    signature: regionSignature(texts, top, fi),
    coreSignature: coreRegionSignature(texts, questionAt, fi, new Set()),
    askRegion: regionSignature(texts, top, fi),
  };
  return { model, startLine: top };
}
