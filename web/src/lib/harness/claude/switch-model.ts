// The "SWITCH MODEL?" CONFIRMATION grammar: the screen Claude Code paints after the `/model` picker
// when the conversation is cached for the current model.
//
// Claude Code 2.1.286 to 2.1.289 draws a modal under the `▔` edge, with NO key-hint footer:
//
//     ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔ ● high · /effort ▔     <- the edge, label sometimes spliced in
//        Switch model?
//        Your next response will be slower and use more tokens
//
//        This conversation is cached for the current model. Switching to Fable 5.1 means the full
//        history gets re-read on your next message.
//
//        ❯ 1. Yes, switch to Fable 5.1                       <- the pointer, on row 1 or on row 2
//          2. No, go back
//
// No other grammar claims it. The footer names no key, so the generic menu (menu.ts) declines, and the
// numbered rows are not a permission dialog (`namesPermissionDialog` wants "Do you want to"), so it
// used to fall to the unread-dialog card, which offers Esc and nothing else (ADR 0053).
//
// PROVEN LIVE, 2026-10-04, Claude Code 2.1.289 (Herdr 0.9.3):
//   * Enter on row 1 switches the model ("Set model to Fable 5.1 for this session only" when the
//     picker was confirmed with `s`). Enter on row 2 returns to the `/model` picker.
//   * The list WRAPS: Down on row 2 goes to row 1, Up on row 1 goes to row 2. It does not clamp, so
//     `clampedEnds` stays unset (ADR 0080 point 6 forbids it on a list that wraps).
//   * Esc cancels.
//   * The digits were NOT probed. They are never sent (ADR 0009): a tap is the arrow walk from the
//     pointer plus Enter, the same plan `pointerWalk` builds for the trust prompt (ADR 0055) and the
//     `/resume` picker (ADR 0058), and the action layer walks, verifies and commits it (ADR 0080).
//
// WHAT A READER NEEDS BEFORE IT CLAIMS THE SCREEN, ALL OF IT (ADR 0053 rule 1: the dialog's own
// words, never one phrase a screen may print):
//   * the region's top is a MODAL EDGE, `▔` (region-top.ts `findRegionTop`, `edge: true`), not a
//     `─` rule;
//   * the first non-blank row under the edge is exactly `Switch model?`;
//   * the last non-blank rows of the screen are the numbered run `1. Yes, switch to <model>` and
//     `2. No, go back`, with nothing under them (so no footer, and a screen scrolled up under other
//     output is declined); row 1 may wrap onto indented continuation rows at a narrow width;
//   * exactly one `❯` in the region, on one of those two rows: none leaves a walk without a start,
//     two is not one list;
//   * no input box on screen.
// Any piece missing returns null and the screen keeps falling to the unread-dialog card.
//
// THE CARD. `prompt-select`, family `select`, like every other walked list that is not a trust or a
// permission question. The question is the title. The two prose paragraphs, the title and the edge
// stay in the raw mirror ABOVE the buttons (`startLine` is the first option row), which is how the
// trust prompt and the AskUserQuestion dialogs pass their body text to the card: nothing new on the
// model. The pointed row's plan is exactly `["Enter"]`.
//
// TWO SIGNATURES. `signature` is the region verbatim from the edge to the last row, pointer included.
// `coreSignature` blanks the pointer glyph and starts at the TITLE row, under the edge. Nothing on
// this screen follows the pointer (no detail row, no counter, no age), so the verify read of a
// walked tap sees the same dialog with the pointer on the tapped row. The edge row is left out of the
// identity because the same screen prints it both ways: the 50-column pair holds a labelled edge
// (`▔▔▔ ● high · /effort ▔`) on the capture with the pointer on row 1 and a bare one on the capture
// with the pointer on row 2, with no key pressed between them that touches the label. Kept in, it
// would make a walked tap answer `changed` whenever the label came or went. The edge stays required
// as evidence, and in `signature`, so a tap on a screen whose edge changed is still refused at entry.
// No `styledSignature`: the pointer is a glyph.
//
// Pure functions over `StyledLine[]`, tail-anchored like every other Claude grammar.

import type { StyledLine } from "../../blocks";
import type { PromptModel, PromptOption } from "../prompt-model";
import { pointerWalk } from "../menu-hints";
import { hasInputBox } from "./chrome";
import { isBlank, lineText } from "./markers";
import { coreRegionSignature, regionSignature, type PromptRegion } from "./prompt-select";
import { findRegionTop } from "./region-top";

/** The dialog's own title, the first non-blank row under the edge. */
const TITLE = "Switch model?";

/** Row 1's label opens with these words and names the model after them. */
const YES_PREFIX = "Yes, switch to ";

/** Row 2's whole label. */
const NO_LABEL = "No, go back";

/** The pointer glyph, and the width of the column it takes: `"❯ "`. */
const POINTER = "❯";
const POINTER_COLUMN = 2;

/** A pointed numbered row: indent, `❯`, one space, the number, a dot, one space, the label. */
const POINTED_ROW = /^( *)❯ ([12])\. (\S.*)$/;
/** An unpointed numbered row: indent, the number, a dot, one space, the label. */
const PLAIN_ROW = /^( *)([12])\. (\S.*)$/;

/** How many continuation rows row 1 may wrap onto. A model name wraps once at most, even at the
 *  narrowest pane Claude draws; the bound keeps a run of body rows from being read as a label. */
const MAX_WRAPPED_ROWS = 3;

interface NumberedRow {
  indent: number;
  pointed: boolean;
  n: number;
  label: string;
}

/** A numbered row of this dialog: its indent, whether `❯` is on it, its number and its label. */
function parseRow(text: string): NumberedRow | null {
  const pointed = POINTED_ROW.exec(text);
  if (pointed !== null) return { indent: pointed[1]!.length, pointed: true, n: Number(pointed[2]), label: pointed[3]! };
  const plain = PLAIN_ROW.exec(text);
  if (plain === null) return null;
  return { indent: plain[1]!.length, pointed: false, n: Number(plain[2]), label: plain[3]! };
}

/** The display column a row's number sits at, whether or not the row carries the pointer. */
function numberColumn(row: NumberedRow): number {
  return row.pointed ? row.indent + POINTER_COLUMN : row.indent;
}

/**
 * Detect the "Switch model?" confirmation at the tail of `lines`. Returns the `prompt-select` model
 * and the index of its first option row, or null when any piece of evidence is missing.
 */
export function detectSwitchModelRegion(lines: StyledLine[]): PromptRegion | null {
  const texts = lines.map(lineText);

  // 1. The tail: the last non-blank row is row 2, and nothing is printed under it.
  let last = texts.length - 1;
  while (last >= 0 && isBlank(texts[last]!)) last--;
  if (last < 0) return null;
  const two = parseRow(texts[last]!.trimEnd());
  if (two === null || two.n !== 2 || two.label !== NO_LABEL) return null;

  // 2. Row 1 above it: possibly wrapped onto continuation rows at the label's own column, never a
  //    blank row between. A row that is numbered, pointed or blank ends the label.
  const twoColumn = numberColumn(two);
  const continuation = twoColumn + "1. ".length;
  let oneAt = -1;
  for (let i = last - 1; i >= 0 && last - 1 - i <= MAX_WRAPPED_ROWS; i--) {
    const text = texts[i]!.trimEnd();
    if (isBlank(text)) return null;
    if (parseRow(text) !== null) {
      oneAt = i;
      break;
    }
    if (text.search(/\S/) !== continuation) return null;
  }
  if (oneAt < 0) return null;
  const one = parseRow(texts[oneAt]!.trimEnd())!;
  if (one.n !== 1) return null;
  // Both rows share the number column, so the pointer shifts neither of them.
  if (numberColumn(one) !== twoColumn) return null;
  // The label may be wrapped: the model name can sit on the continuation row.
  const wrapped = texts.slice(oneAt + 1, last).map((t) => t.trim());
  const yesLabel = [one.label.trim(), ...wrapped].join(" ");
  if (!yesLabel.startsWith(YES_PREFIX) || yesLabel.length === YES_PREFIX.length) return null;

  // 3. The region's top: the MODAL EDGE, `▔`, not a `─` rule. The title is the first non-blank row
  //    under it, exactly.
  const top = findRegionTop(texts, last);
  if (top === null || !top.edge) return null;
  let titleAt = top.line + 1;
  while (titleAt < oneAt && isBlank(texts[titleAt]!)) titleAt++;
  if (titleAt >= oneAt || texts[titleAt]!.trim() !== TITLE) return null;

  // 4. The pointer: exactly one `❯` in the region, on row 1 or row 2 (a pointed row is the only
  //    shape `parseRow` takes it on, so a stray one in the prose is a second pointer and declines).
  let pointers = 0;
  for (let i = top.line; i <= last; i++) {
    for (const ch of texts[i]!) if (ch === POINTER) pointers++;
  }
  if (pointers !== 1 || one.pointed === two.pointed) return null;
  const pointedAt = one.pointed ? 0 : 1;

  // 5. A modal, never a live composer.
  if (hasInputBox(lines)) return null;

  const options: PromptOption[] = [
    { label: yesLabel, keys: pointerWalk(pointedAt, 0) },
    { label: NO_LABEL, keys: pointerWalk(pointedAt, 1) },
  ];
  // The row the pointer stands on is the one a bare Enter takes. `PromptOption` has no default flag,
  // so the badge carries it, as on the trust prompt: the terminal's own glyph on the pointed row, the
  // arrow its tap starts with on the other.
  options[pointedAt] = { ...options[pointedAt]!, keyLabel: POINTER };

  const model: PromptModel = {
    question: TITLE,
    options,
    family: "select",
    // Byte-faithful from the edge through the last row: the pointer column included, so a pointer
    // moved between the render and the tap refuses the tap (ADR 0055 point 6).
    signature: regionSignature(texts, top.line, last),
    // The same rows from the title down with the pointer glyph blanked and nothing else: nothing on
    // this screen follows the pointer, and a changed title, label, model name or row still moves the
    // identity (ADR 0080 point 5). The edge above the title is chrome that comes and goes (header).
    coreSignature: coreRegionSignature(texts, titleAt, last, new Set()),
  };
  return { model, startLine: oneAt };
}

/** The model alone (or null), the thin matcher tests assert on. */
export function detectSwitchModel(lines: StyledLine[]): PromptModel | null {
  return detectSwitchModelRegion(lines)?.model ?? null;
}
