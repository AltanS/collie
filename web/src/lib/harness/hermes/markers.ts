// The vocabulary of Hermes Agent's classic CLI (the prompt_toolkit one `hermes` starts by default;
// `hermes --tui` is the separate Ink front end, not read here). Every string below was read from the
// Hermes source at v0.22.2 (`hermes_cli/cli_tui_mixin.py`, `locales/en.yaml`) and seen in the
// captures under fixtures/panes/hermes--*.txt. The English locale only: a panel in another language
// matches nothing here and stays raw.
//
// Pure helpers over StyledLine; no pane access.

import { isBlank, lineText, type StyledLine } from "../../blocks";

export { isBlank, lineText };

/** Trailing whitespace off: the grid pads some rows and not others. */
export function rstrip(text: string): string {
  return text.replace(/\s+$/, "");
}

/** Every row's text, trailing pad dropped. */
export function rowTexts(lines: StyledLine[]): string[] {
  return lines.map((l) => rstrip(lineText(l)));
}

/** The index of the last non-blank row at or above `from`, or -1. */
export function lastNonBlankIndex(texts: string[], from = texts.length - 1): number {
  for (let i = from; i >= 0; i--) if (!isBlank(texts[i]!)) return i;
  return -1;
}

/** A rule drawn across the input: the `─` run above and (on a wide pane) below the input row. */
export function isRule(text: string): boolean {
  return /^─{8,}$/.test(text);
}

/** Hermes drops the rule under the input below this width (`_use_minimal_tui_chrome`), and with it
 *  the spinner row and the `❯` after a state icon. A rule this long or longer is a wide layout's. */
export const WIDE_COLUMNS = 64;

// The panel box every Hermes modal draws (`_Panel` in hermes_cli/cli_tui_mixin.py). `[\s\S]`, never
// `.`: a row of terminal text may hold U+2028/U+2029, which `.` does not match.
export const PANEL_TOP = /^╭─[\s\S]*╮$/;
export const PANEL_BOTTOM = /^╰─+╯$/;
const PANEL_SIDE = /^│[\s\S]*│$/;

/** A body row of a panel box: `│ … │`. */
export function isPanelRow(text: string): boolean {
  return PANEL_SIDE.test(text);
}

/** What a panel body row says, between its sides: the one space of padding after `│` dropped,
 *  trailing pad dropped. Null for a row that is not a body row. */
export function panelInterior(text: string): string | null {
  if (!isPanelRow(text) || text.length < 2) return null;
  const inner = text.slice(1, -1);
  return rstrip(inner.startsWith(" ") ? inner.slice(1) : inner);
}

/**
 * The same row as {@link panelInterior}, styles kept: the side glyphs and their one space of padding
 * cut off the segments, for a card that shows the panel's rows (`PromptModel.subject`). Assumes the
 * row is a body row; the caller checked.
 */
export function panelInteriorLine(line: StyledLine): StyledLine {
  const text = lineText(line);
  const start = text.startsWith("│ ") ? 2 : 1;
  const close = text.lastIndexOf("│");
  const end = close > start ? close : text.length;
  const segments: StyledLine["segments"] = [];
  let at = 0;
  for (const segment of line.segments) {
    const from = Math.max(start, at);
    const to = Math.min(end, at + segment.text.length);
    if (to > from) segments.push({ ...segment, text: segment.text.slice(from - at, to - at) });
    at += segment.text.length;
  }
  // The trailing pad is not content, and it can span segments (the text's own, then the side's).
  while (segments.length > 0) {
    const last = segments.at(-1)!;
    const trimmed = rstrip(last.text);
    if (trimmed === last.text) break;
    if (trimmed === "") segments.pop();
    else segments[segments.length - 1] = { ...last, text: trimmed };
  }
  return { segments };
}

/**
 * Panel body rows as a card's `subject`: each through {@link panelInteriorLine}, leading and trailing
 * blank rows trimmed and a run of blank rows kept as one (`PromptModel.subject`).
 */
export function panelSubject(lines: StyledLine[]): StyledLine[] {
  const out: StyledLine[] = [];
  for (const line of lines.map(panelInteriorLine)) {
    const blank = isBlank(lineText(line));
    if (blank && (out.length === 0 || isBlank(lineText(out.at(-1)!)))) continue;
    out.push(line);
  }
  while (out.length > 0 && isBlank(lineText(out.at(-1)!))) out.pop();
  return out;
}

/** The status bar: Hermes's `☤` marker, after a battery field when one is shown, then the model
 *  (`_get_status_bar_fragments` in hermes_cli/cli_status_bar_mixin.py). The marker is not a skin's. */
export const STATUS_BAR = /^ ?(?:[^│☤]{1,20} │ )?☤ \S/;

/** The last row of the spinner Hermes paints above a panel's hint while the panel's tool runs:
 *  `  {text}  ({elapsed} · {tokens})`, elapsed ` 52.6s` or `01m07s` (`_render_spinner_text`). */
export const SPINNER_END = /\((?: *\d+\.\d+s|\d+m\d+s)(?: · [^()]+)?\)$/;

/** The key-hint row Hermes prints under a panel, its countdown `(Ns)` optional (absent when the
 *  timeout is unlimited). `hint_clarify_batch` and `hint_approval` in
 *  locales/en.yaml; the countdown is `_poll_modal_queue`'s, repainted about once a second. */
export const CLARIFY_HINT = /^ {2}↑\/↓ to select, Enter to lock, Tab next question(?: {2}\(\d+s\))?$/;
export const APPROVAL_HINT = /^ {2}↑\/↓ to select, Enter to confirm(?: {2}\(\d+s\))?$/;
