// The omp `ask` tool's SINGLE-SELECT dialog grammar (.adr/0077), the second omp screen this adapter
// lifts. The `ask` tool blocks the agent until a human answers, which is why it is worth a card.
//
// The screen, as omp 18.4.10 draws it (`omp--v18-4-ask-single.txt`; pi-tui `overlays/ask-dialog.ts`):
//
//     ╭─ Ask ───────────────────────────────────────────────╮     the panel title, exactly `Ask`
//     │ Pick a color                                        │     the question, one to four rows
//     ├─────────────────────────────────────────────────────┤
//     │ ❯ ○ Red                                             │     an option: pointer column, radio, label
//     │   ○ Green                                           │
//     │   ○ Blue                                            │
//     │   ○ Other (type your own)                           │     always the last row, omp adds it
//     │                                                     │     blank rows pad the body to its height
//     ├─────────────────────────────────────────────────────┤
//     │ ⏎ select · n note · ↑/↓ move · ⎋ cancel             │     the footer
//     ╰─────────────────────────────────────────────────────╯
//
// THE FOOTER IS THE CONTRACT. omp builds it from what the dialog will do with a key, so this grammar
// reads it whole and accepts exactly four segments, `<enter> select`, `n note`, `↑/↓ move`,
// `<esc> cancel`, in one of three keycap dialects (the PRESETS below). That one comparison carries
// three facts at once:
//   * a SINGLE-select question, because a multi-select one prints `␣ toggle` (and, before omp 18.4,
//     `Space/Enter toggle`) in the first segment;
//   * a ONE-question dialog, because several questions add a `⇥/←/→` tab segment and a tab strip, and
//     there Enter advances to the next question instead of answering;
//   * Up and Down are the keys that move the pointer, because omp prints the user's bound keys there.
// A footer with a scroll indicator, a `ctrl+o expand` hint, a countdown, or anything else this grammar
// was not built against is a different footer, and the screen stays raw with the Escape card over it.
//
// WHAT A TAP SENDS. ADR 0055's walk: `Down` or `Up` from the pointed row to the tapped one, then `Enter`,
// as one batch, a key the footer printed. In a one-question dialog Enter on an option answers the
// question and closes the dialog (`#commitRow` → `#advanceAfterQuestion` → `#finishSubmit` in 18.4.10).
// Enter on `Other (type your own)` opens the answer editor instead, which omp/answer-editor.ts reads as
// an input, so the phone's composer types the answer there. That row is offered like any other, because
// the next screen is one the phone already handles and the row's own label says what it does. The card's
// last row is the footer's way out in its own words (`Cancel`), sending `Escape`. No digit anywhere:
// the screen printed none, and the dialog ignores digits.
//
// NOT MODELLED. `n note` opens the same editor for a note on the pointed row; `PromptModel` has no field
// for a footer action, so it stays off the card, and the Keys drawer reaches it. A row that already
// carries a note shows `  ✎ note` after its label (`omp--select-menu-noted.txt`), which becomes the
// option's description.
//
// FAIL CLOSED. Every piece below is required, and any one missing returns null:
//   * the bottom border is the last non-blank row, the footer is the row above it, a divider above that;
//   * the footer's four segments are exactly one preset's;
//   * the body is option rows, then blank rows, nothing else: no description row, no wrapped label, no
//     preview, no scrollbar cell (omp can print all four; none is captured, so none is guessed);
//   * every option row carries that preset's unselected radio, the last one reads exactly
//     `Other (type your own)`, and no other row does;
//   * exactly one pointer, in that preset's glyph;
//   * a divider, one to four question rows and the title `╭─ Ask ─╮` above the body, in that order.
//     The question rows are free text and are checked only for the box's left side, as resume.ts checks
//     a session's first-prompt row: their bytes ride in the signature, and nothing reads a key off them;
//   * a region short enough for the bridge to bind (32000 characters, as resume.ts).
//
// THE MULTI-SELECT DIALOG IS NOT LIFTED, on purpose (.adr/0077): its toggle is an arrow walk then Space,
// a recipe no shared model carries, and its Enter changed meaning between omp versions. It keeps the
// raw mirror and the Escape card. See ASK_NOTES.md.
//
// Pure functions over `StyledLine[]`, tail-anchored like every other grammar.

import type { StyledLine } from "../../blocks";
import { pointerWalk } from "../menu-hints";
import type { PromptModel, PromptOption } from "../prompt-model";
import { isBlank, lineText, rstrip } from "./markers";
import { readOmpHintList } from "./modal";

export interface AskSelectRegion {
  model: PromptModel;
  /** Index of the title row: the region is [`startLine` … the bottom border at the tail]. */
  startLine: number;
}

/** One keycap dialect: the footer's two keycaps and the glyphs the same symbol preset draws in the
 *  body. A screen must match ONE preset in all four places, so a footer from one preset over rows from
 *  another is not a screen this grammar knows. */
interface Preset {
  enter: string;
  escape: string;
  /** `theme.nav.cursor`, the pointer in front of the pointed row. */
  pointer: string;
  /** `theme.radio.unselected`, the marker in front of every option of a single-select question. */
  radio: string;
}

const PRESETS: readonly Preset[] = [
  // omp 18.4 `unicode` preset, the default (`omp--v18-4-ask-single.txt`).
  { enter: "⏎", escape: "⎋", pointer: "❯", radio: "○" },
  // omp 17.x text keycaps over the same glyphs (`omp--select-menu.txt`, v17.2.12).
  { enter: "Enter", escape: "Esc", pointer: "❯", radio: "○" },
  // omp's `nerd` preset, private-use glyphs (`omp--select-menu-other.txt`, v18.4.4): U+F0311 for Enter,
  // U+F12B7 for Escape, U+F054 (nf-fa-chevron_right) as the pointer, U+F10C (nf-fa-circle_o) as the radio.
  { enter: "\u{F0311}", escape: "\u{F12B7}", pointer: "\u{F054}", radio: "\u{F10C}" },
];

/** The footer, segment by segment, for a preset. Compared exactly: see the header. */
function footerOf(preset: Preset): string[] {
  return [`${preset.enter} select`, "n note", "↑/↓ move", `${preset.escape} cancel`];
}

/** omp's own label for the free-text row (`OTHER_OPTION` in ask-dialog.ts). omp renames any option
 *  that would collide with it, so it appears once, last. */
const OTHER_LABEL = "Other (type your own)";

/** The mark a saved note leaves after its row's label (`noteMarker` in ask-dialog.ts). */
const NOTE_MARK = /^(.*\S) {2}✎ note$/;

/** The bridge's cap on a bound region less a margin, as resume.ts. */
const MAX_REGION_CHARS = 32_000;

/** omp caps the question at four rows before it offers `ctrl+o expand` (`MAX_HEADER_ROWS`). */
const MAX_QUESTION_ROWS = 4;

/** How tall the body may be: omp gives the dialog at most 70 % of the terminal, and the bound only
 *  keeps a scan from running into scrollback. */
const MAX_BODY_ROWS = 200;

/** The badge on the pointed row. The nerd preset's chevron is a private-use glyph the card's face may
 *  not carry, so every preset shows the `❯` it stands for. */
const POINTER_BADGE = "❯";

const TITLE = /^╭─ Ask ─+╮$/;
const DIVIDER = /^├─+┤$/;
const BOTTOM = /^╰─+╯$/;
const BOX_ROW = /^│ ([\s\S]*)│$/;
/** A question row: the box's left side, then free text up to its right side if there is one. */
const QUESTION_ROW = /^│ ([\s\S]*?)(?:\s*│)?$/;
const BLANK_ROW = /^│\s*│$/;

interface Option {
  label: string;
  note: boolean;
  pointed: boolean;
}

/**
 * Detect the Ask tool's one-question single-select dialog at the tail of `lines`. Returns a
 * `prompt-select` model whose options are the listed rows (the `Other` row included) plus the footer's
 * own way out, and the index of the title row; null when any piece of evidence is missing.
 */
export function detectAskSelectRegion(lines: StyledLine[]): AskSelectRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));

  // 1. The tail: bottom border, footer, divider.
  let end = texts.length - 1;
  while (end >= 0 && isBlank(texts[end]!)) end--;
  if (end < 6 || !BOTTOM.test(texts[end]!)) return null;
  const footerRow = BOX_ROW.exec(texts[end - 1]!);
  if (footerRow === null) return null;
  const footer = readOmpHintList(footerRow[1]!);
  if (footer === null) return null;
  const preset = PRESETS.find((p) => sameSegments(footer.segments, footerOf(p)));
  if (preset === undefined) return null;
  const lowerDivider = end - 2;
  if (!DIVIDER.test(texts[lowerDivider]!)) return null;

  // 2. The body, read upward to the divider under the question.
  let upperDivider = lowerDivider - 1;
  while (upperDivider >= 0 && !DIVIDER.test(texts[upperDivider]!)) {
    if (lowerDivider - upperDivider > MAX_BODY_ROWS || !BOX_ROW.test(texts[upperDivider]!)) return null;
    upperDivider--;
  }
  if (upperDivider < 0 || !DIVIDER.test(texts[upperDivider]!)) return null;
  const options = readBody(texts.slice(upperDivider + 1, lowerDivider), preset);
  if (options === null) return null;

  // 3. The question, one to four boxed rows, and the title above it.
  let titleAt = upperDivider - 1;
  const question: string[] = [];
  while (titleAt >= 0 && !TITLE.test(texts[titleAt]!)) {
    const row = QUESTION_ROW.exec(texts[titleAt]!);
    if (row === null || question.length === MAX_QUESTION_ROWS) return null;
    question.unshift(row[1]!.trim());
    titleAt--;
  }
  if (titleAt < 0) return null;
  const questionText = question.filter((q) => q.length > 0).join(" ");
  if (questionText.length === 0) return null;

  // 4. The signature is the region verbatim, title through the bottom border, trailing padding off.
  //    It carries the pointer column of every row, so a pointer moved between the render and the tap
  //    refuses the tap (ADR 0055 point 6).
  const region = texts.slice(titleAt, end + 1);
  const signature = region.join("\n");
  if (signature.length > MAX_REGION_CHARS) return null;
  const pointedAt = options.findIndex((o) => o.pointed);
  const pointedRow = upperDivider + 1 + pointedAt;
  const coreSignature = region
    .map((row, i) => (titleAt + i === pointedRow ? row.replace(preset.pointer, " ") : row))
    .join("\n");

  const promptOptions: PromptOption[] = options.map((option, i) => {
    // The footer names the arrows, not a row key, so the pointed row shows the pointer and every
    // other row shows no badge, as resume.ts does.
    const row: PromptOption = {
      label: option.label,
      keys: pointerWalk(pointedAt, i),
      keyLabel: i === pointedAt ? POINTER_BADGE : "",
    };
    if (option.note) row.description = "✎ note";
    return row;
  });
  // The footer's own way out, in its own words, as the last row (ADR 0058 point 5).
  promptOptions.push({ label: capitalise(footer.escapeVerb), keys: ["Escape"], keyLabel: "Esc" });

  const model: PromptModel = {
    question: questionText,
    options: promptOptions,
    family: "select",
    signature,
    coreSignature,
  };
  return { model, startLine: titleAt };
}

/** The model alone (or null), the thin matcher tests assert on. */
export function detectAskSelect(lines: StyledLine[]): PromptModel | null {
  return detectAskSelectRegion(lines)?.model ?? null;
}

/**
 * The body's rows as options, or null. Option rows come first and are contiguous, then blank rows to
 * the divider; anything else declines. Each option row is the pointer column (the preset's pointer or
 * a space), a space, the preset's unselected radio, a space and the label.
 */
function readBody(rows: string[], preset: Preset): Option[] | null {
  const options: Option[] = [];
  let padding = false;
  for (const row of rows) {
    if (BLANK_ROW.test(row)) {
      padding = true;
      continue;
    }
    // A row of text below a blank one is not this layout: omp pads only after the last option.
    if (padding) return null;
    const option = readOption(row, preset);
    if (option === null) return null;
    options.push(option);
  }
  // At least one real option above the `Other` row, which must be last and must be the only one.
  if (options.length < 2) return null;
  if (options.at(-1)!.label !== OTHER_LABEL) return null;
  if (options.slice(0, -1).some((o) => o.label === OTHER_LABEL)) return null;
  if (options.filter((o) => o.pointed).length !== 1) return null;
  return options;
}

function readOption(row: string, preset: Preset): Option | null {
  const inner = BOX_ROW.exec(row)?.[1]?.replace(/\s+$/, "");
  if (inner === undefined) return null;
  const pointed = inner.startsWith(`${preset.pointer} ${preset.radio} `);
  if (!pointed && !inner.startsWith(`  ${preset.radio} `)) return null;
  const rest = inner.slice((pointed ? preset.pointer.length : 1) + 1 + preset.radio.length + 1);
  if (rest.length === 0 || /^\s/.test(rest)) return null;
  const noted = NOTE_MARK.exec(rest);
  return { label: noted === null ? rest : noted[1]!, note: noted !== null, pointed };
}

function sameSegments(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
