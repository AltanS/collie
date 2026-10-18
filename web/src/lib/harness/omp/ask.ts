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
// a key the footer printed. The action layer walks, verifies, then commits (ADR 0080): the arrows go
// first, bound to the tapped screen, and `Enter` goes only bound to a fresh read that shows the pointer
// on the tapped row. In a one-question dialog Enter on an option answers the
// question and closes the dialog (`#commitRow` → `#advanceAfterQuestion` → `#finishSubmit` in 18.4.10).
// Enter on `Other (type your own)` opens the answer editor instead, which omp/answer-editor.ts reads as
// an input, so the phone's composer types the answer there. That row is offered like any other, because
// the next screen is one the phone already handles and the row's own label says what it does. The card's
// last row is the footer's way out in its own words (`Cancel`), sending `Escape`. No digit anywhere:
// the screen printed none, and the dialog ignores digits.
//
// NOT MODELLED. `n note` opens the same editor for a note on the pointed row; `PromptModel` has no field
// for a footer action, so it stays off the card, and the Keys drawer reaches it. A row that already
// carries a note shows `  ✎ note` after its label (`omp--select-menu-noted.txt`). On the card that
// mark is the option's description, or leads it as `✎ note · <description>` when omp prints one.
//
// OPTION DESCRIPTIONS (#372). An option the agent gave a `description` carries it on rows of its
// own under the label, six columns in (two past the label), wrapped at that indent; the 18.4.10
// source draws them as well, and `omp--v18-8-ask-single-described.txt` captures them on 18.8.0:
//
//     │ ❯ ○ Staging (Recommended)                           │
//     │       Deploy to the staging cluster first, run the  │     a description, wrapped
//     │       full smoke suite against it, …                │
//     │   ○ Production                                      │
//     │       Ship straight to production.                  │
//
// The rows join, one space apart, into that option's `description` on the card. omp draws every
// option's description wherever the pointer is, so a walk moves the pointer and nothing else
// (`omp--v18-8-ask-single-described-moved.txt`, 18.8.7). omp shows two rows of a description and adds
// `<key> expand` to the footer when one runs longer, a footer this grammar declines, so a lifted
// description is never cut short.
//
// FAIL CLOSED. Every piece below is required, and any one missing returns null:
//   * the bottom border is the last non-blank row, the footer is the row above it, a divider above that;
//   * the footer's four segments are exactly one preset's;
//   * the body is option rows, each followed by its description rows, then blank rows, nothing else:
//     no wrapped label, no preview, no scrollbar cell (omp can print all three; none is captured, so
//     none is guessed);
//   * a description row is exactly six columns in, under an option or that option's previous
//     description row, never under `Other` (omp prints an answer typed earlier there, at the same
//     indent), never behind a `│` (an option's preview, at the same indent), and never opening with
//     the preset's radio or pointer, the glyphs of an option row;
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
// omp 18.10 (`omp--v18-10-ask-*.txt`, ASK_NOTES.md). Where the three sections below differ from the
// text above, they are current: the footer may now end `Alt+H hide` and `Ctrl+O expand`/`collapse`.
//
// BATCHED QUESTIONS. A call with several single-select questions adds the `⇥/←/→ question` footer
// segment and a tab strip whose active tab is marked by background and bold ONLY. The grammar reads
// the strip, binds the active tab's index into `coreSignature` and binds the styled region, so two
// steps with identical words are not mistaken for one another. Enter saves the answer and advances; a
// revisited step may show one saved `◉` answer. Unknown controls, scroll indicators and anything the
// strip cannot place still decline.
//
// THE REVIEW SCREEN. After the last question omp draws a review: one numbered answer per tab, the
// Submit tab active and a static `❯ Submit` row, under the footer `⏎ submit · ↑/↓ scroll · ⎋ cancel`.
// Its arrows SCROLL, they do not move a pointer, so Submit sends Enter alone. It is read only when
// every answer is present and nothing is clipped or warned about; the numbers are never digit keys.
//
// THE `Ctrl+O expand` STATE. omp cuts a question past four rows and a description past two, and says
// `Ctrl+O expand`. In that cut state the card offers only Expand (that key, alone) and Cancel, and no
// answer. The answer buttons appear once the screen shows `Ctrl+O collapse`, which proves the whole
// text is on screen.
//
// Pure functions over `StyledLine[]`, tail-anchored like every other grammar.

import type { StyledLine } from "../../blocks";
import { canonicalStyledLines, encodeStyledRegion } from "../../styled-region";
import { MAX_REGION_CHARS } from "../bound-region";
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
function footerOf(preset: Preset, tabbed: boolean): string[] {
  const segments = [`${preset.enter} select`, "n note", "↑/↓ move"];
  if (tabbed) segments.push("⇥/←/→ question");
  segments.push(`${preset.escape} cancel`);
  return segments;
}

/** omp's own label for the free-text row (`OTHER_OPTION` in ask-dialog.ts). omp renames any option
 *  that would collide with it, so it appears once, last. */
const OTHER_LABEL = "Other (type your own)";

/** The mark a saved note leaves after its row's label (`noteMarker` in ask-dialog.ts). */
const NOTE_MARK = /^(.*\S) {2}✎ note$/;

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
/** An option's description row: the box's left side and its padding space, the six columns omp
 *  indents every description row by, then text. A long description wraps onto more rows at that
 *  same indent (`omp--v18-8-ask-single-described.txt`). The text never opens with `│`: that is the
 *  rail of an option's `preview`, which omp draws at the same indent and this grammar does not read. */
const DESCRIPTION_ROW = /^│ {7}([^\s│][\s\S]*?)\s*│$/;

interface Option {
  label: string;
  note: boolean;
  pointed: boolean;
  selected: boolean;
  /** The option row's index in the body. Description rows push every option below them down. */
  bodyRow: number;
  /** The option's description rows, joined with a space; absent when omp printed none. */
  description?: string;
}

/**
 * Detect a supported single-select question or complete batch review at the tail of `lines`.
 * Returns its guarded `prompt-select` model and title row; null when evidence is missing.
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
  const tabbed = footer.segments.includes("⇥/←/→ question");
  const preset = PRESETS.find((p) => (!tabbed || p.enter === "⏎") && matchesAskFooter(footer.segments, footerOf(p, tabbed), true));
  if (preset === undefined) return readReview(lines, texts, end, footer.segments);
  const truncated = footer.segments.at(-1) === "Ctrl+O expand";
  const maxQuestionRows = footer.segments.at(-1) === "Ctrl+O collapse" ? MAX_BODY_ROWS : MAX_QUESTION_ROWS;
  const lowerDivider = end - 2;
  if (!DIVIDER.test(texts[lowerDivider]!)) return null;

  // 2. The body, read upward to the divider under the question.
  let upperDivider = lowerDivider - 1;
  while (upperDivider >= 0 && !DIVIDER.test(texts[upperDivider]!)) {
    if (lowerDivider - upperDivider > MAX_BODY_ROWS || !BOX_ROW.test(texts[upperDivider]!)) return null;
    upperDivider--;
  }
  if (upperDivider < 0 || !DIVIDER.test(texts[upperDivider]!)) return null;
  const options = readBody(texts.slice(upperDivider + 1, lowerDivider), preset, tabbed);
  if (options === null) return null;

  // 3. The question and, for a batch, its styled tab strip beneath the title.
  let titleAt = upperDivider - 1;
  const question: string[] = [];
  while (titleAt >= 0 && !TITLE.test(texts[titleAt]!)) {
    const row = QUESTION_ROW.exec(texts[titleAt]!);
    if (row === null || question.length === maxQuestionRows + (tabbed ? 1 : 0)) return null;
    question.unshift(row[1]!.trim());
    titleAt--;
  }
  if (titleAt < 0) return null;
  const tabs = tabbed ? readTabs(lines[titleAt + 1]!) : null;
  if (tabbed) {
    if (tabs === null || tabs.current === tabs.labels.length - 1) return null;
    question.shift();
  }
  const questionText = question.filter((q) => q.length > 0).join(" ");
  if (questionText.length === 0) return null;

  // 4. The signature is the region verbatim, title through the bottom border, trailing padding off.
  //    It carries the pointer column of every row, so a pointer moved between the render and the tap
  //    refuses the tap (ADR 0055 point 6).
  const region = texts.slice(titleAt, end + 1);
  const signature = region.join("\n");
  if (signature.length > MAX_REGION_CHARS) return null;
  const pointedAt = options.findIndex((o) => o.pointed);
  const pointedRow = upperDivider + 1 + options[pointedAt]!.bodyRow;
  const coreSignature = region
    .map((row, i) => (titleAt + i === pointedRow ? row.replace(preset.pointer, " ") : row))
    .join("\n");

  const promptOptions: PromptOption[] = truncated
    ? [{ label: "Expand", keys: ["ctrl+o"], keyLabel: "Ctrl+O" }]
    : options.map((option, i) => {
    // The footer names the arrows, not a row key, so the pointed row shows the pointer and every
    // other row shows no badge, as resume.ts does.
    const row: PromptOption = {
      label: option.label,
      keys: pointerWalk(pointedAt, i),
      keyLabel: i === pointedAt ? POINTER_BADGE : "",
    };
    if (option.note) row.description = "✎ note";
    // A description omp printed under the row follows the note's mark, in screen order.
    if (option.description !== undefined) {
      row.description = option.note ? `✎ note · ${option.description}` : option.description;
    }
    return row;
  });
  // The footer's own way out, in its own words, as the last row (ADR 0058 point 5).
  promptOptions.push({ label: capitalise(footer.escapeVerb), keys: ["Escape"], keyLabel: "Esc" });

  const model: PromptModel = {
    question: questionText,
    options: promptOptions,
    family: "select",
    signature,
    coreSignature: tabs === null ? coreSignature : `${coreSignature}\nquestion-tab:${tabs.current}`,
  };
  if (tabs !== null) {
    model.caption = `Ask (${tabs.current + 1}/${tabs.labels.length - 1}) · ${tabs.labels[tabs.current]}`;
    model.styledSignature = encodeStyledRegion(canonicalStyledLines(lines.slice(titleAt, end + 1)));
  }
  return { model, startLine: titleAt };
}

/** The model alone (or null), the thin matcher tests assert on. */
export function detectAskSelect(lines: StyledLine[]): PromptModel | null {
  return detectAskSelectRegion(lines)?.model ?? null;
}

/** Review Enter submits once; Up/Down scroll here and must never be a pointer walk. */
function readReview(lines: StyledLine[], texts: string[], end: number, footer: string[]): AskSelectRegion | null {
  if (!matchesAskFooter(footer, ["⏎ submit", "↑/↓ scroll", "⎋ cancel"])) return null;
  const lowerDivider = end - 2;
  if (!DIVIDER.test(texts[lowerDivider]!)) return null;
  let upperDivider = lowerDivider - 1;
  while (upperDivider >= 0 && !DIVIDER.test(texts[upperDivider]!)) {
    if (lowerDivider - upperDivider > MAX_BODY_ROWS || !BOX_ROW.test(texts[upperDivider]!)) return null;
    upperDivider--;
  }
  const titleAt = upperDivider - 3;
  if (titleAt < 0 || !TITLE.test(texts[titleAt]!)) return null;
  if (BOX_ROW.exec(texts[titleAt + 2]!)?.[1]?.trim() !== "Review answers") return null;
  const tabs = readTabs(lines[titleAt + 1]!);
  if (tabs === null || tabs.labels.length < 3 || tabs.current !== tabs.labels.length - 1) return null;
  const rows = texts.slice(upperDivider + 1, lowerDivider)
    .map((row) => BOX_ROW.exec(row)![1]!.trim()).filter((row) => row !== "");
  if (rows.length !== tabs.labels.length || rows.at(-1) !== "❯ Submit") return null;
  for (let i = 0; i < tabs.labels.length - 1; i++) {
    const prefix = `${i + 1}. ${tabs.labels[i]}: `;
    if (!rows[i]!.startsWith(prefix) || rows[i]!.length === prefix.length) return null;
  }
  const signature = texts.slice(titleAt, end + 1).join("\n");
  if (signature.length > MAX_REGION_CHARS) return null;
  return {
    startLine: titleAt,
    model: {
      family: "select",
      question: ["Review answers", ...rows.slice(0, -1)].join("\n"),
      options: [
        { label: "Submit", keys: ["Enter"], keyLabel: "⏎" },
        { label: "Cancel", keys: ["Escape"], keyLabel: "Esc" },
      ],
      signature,
      coreSignature: `${signature}\nquestion-tab:${tabs.current}`,
      styledSignature: encodeStyledRegion(canonicalStyledLines(lines.slice(titleAt, end + 1))),
    },
  };
}

interface AskTabs {
  labels: string[];
  current: number;
}

/** The current tab is bold with a background; its text alone never identifies the step. */
function readTabs(line: StyledLine): AskTabs | null {
  const text = rstrip(lineText(line));
  const inner = BOX_ROW.exec(text)?.[1];
  if (inner === undefined) return null;
  const labels = inner.trim().split(/ {2,}/);
  if (labels.length < 2 || labels.at(-1) !== "Submit") return null;
  let offset = 0;
  let current = -1;
  for (const segment of line.segments) {
    const label = segment.text.trim();
    if (segment.bg !== undefined && segment.bold && label.length > 0) {
      if (current !== -1) return null;
      const start = offset + segment.text.indexOf(label);
      let searchAt = 2;
      for (let i = 0; i < labels.length; i++) {
        const at = text.indexOf(labels[i]!, searchAt);
        if (at < 0) return null;
        if (at === start && label === labels[i]) current = i;
        searchAt = at + labels[i]!.length;
      }
      if (current === -1) return null;
    }
    offset += segment.text.length;
  }
  return current === -1 ? null : { labels, current };
}

/**
 * The body's rows as options, or null. Option rows come first and are contiguous, each followed by
 * its description rows if it has any, then blank rows to the divider; anything else declines. Each
 * option row is the pointer column (the preset's pointer or a space), a space, the preset's
 * unselected radio, a space and the label.
 */
function readBody(rows: string[], preset: Preset, allowSelected: boolean): Option[] | null {
  const options: Option[] = [];
  let padding = false;
  for (let at = 0; at < rows.length; at++) {
    const row = rows[at]!;
    if (BLANK_ROW.test(row)) {
      padding = true;
      continue;
    }
    // A row of text below a blank one is not this layout: omp pads only after the last option.
    if (padding) return null;
    const description = DESCRIPTION_ROW.exec(row)?.[1];
    if (description !== undefined) {
      // Directly under its option, or under that option's previous description row. Never under
      // `Other`: omp prints that indent there only for an answer typed earlier, not a description.
      // Never opening with the radio or the pointer either: those glyphs open an option row.
      const owner = options.at(-1);
      if (owner === undefined || owner.label === OTHER_LABEL) return null;
      if (description.startsWith(preset.radio) || description.startsWith(preset.pointer) || description.startsWith("◉")) return null;
      owner.description = owner.description === undefined ? description : `${owner.description} ${description}`;
      continue;
    }
    const option = readOption(row, preset, at, allowSelected);
    if (option === null) return null;
    options.push(option);
  }
  // At least one real option above the `Other` row, which must be last and must be the only one.
  if (options.length < 2) return null;
  if (options.at(-1)!.label !== OTHER_LABEL) return null;
  if (options.slice(0, -1).some((o) => o.label === OTHER_LABEL)) return null;
  if (options.filter((o) => o.pointed).length !== 1) return null;
  if (options.filter((o) => o.selected).length > 1) return null;
  return options;
}

function readOption(row: string, preset: Preset, bodyRow: number, allowSelected: boolean): Option | null {
  const inner = BOX_ROW.exec(row)?.[1]?.replace(/\s+$/, "");
  if (inner === undefined) return null;
  const selected = allowSelected && (inner.startsWith(`${preset.pointer} ◉ `) || inner.startsWith("  ◉ "));
  const radio = selected ? "◉" : preset.radio;
  const pointed = inner.startsWith(`${preset.pointer} ${radio} `);
  if (!pointed && !inner.startsWith(`  ${radio} `)) return null;
  const rest = inner.slice((pointed ? preset.pointer.length : 1) + 1 + radio.length + 1);
  if (rest.length === 0 || /^\s/.test(rest)) return null;
  const noted = NOTE_MARK.exec(rest);
  return { label: noted === null ? rest : noted[1]!, note: noted !== null, pointed, selected, bodyRow };
}

function matchesAskFooter(segments: string[], expected: string[], allowExpansion = false): boolean {
  let length = segments.length;
  if (allowExpansion && /^Ctrl\+O (?:expand|collapse)$/.test(segments[length - 1]!)) length--;
  if (segments[length - 1] === "Alt+H hide") length--;
  return length === expected.length && expected.every((segment, i) => segment === segments[i]);
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
