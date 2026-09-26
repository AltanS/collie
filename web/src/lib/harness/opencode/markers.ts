// Shared lexing helpers for the opencode harness — the glyph predicates the composer scanner and
// the permission-dialog detector lean on. Same methodology as the other adapters' markers (pure
// functions over the PARSED line text, no I/O, no React) and deliberately NOT their code: opencode
// draws a composer unlike every other TUI in the tree.
//
// opencode 2.0.8's composer is not a rounded box. It is a LEFT VERTICAL BAR run with a rule under it:
//
//     ┃  (blank interior padding)
//     ┃  Ask anything… "Fix broken tests"        <- the placeholder, when the draft is empty
//     ┃  <the draft, word-wrapped onto more bar rows>
//     ┃
//     ┃  Build · GLM-5.3-Flash OpenCode Go · max  <- the model/agent row: the LAST interior row
//     ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀                        <- the bottom rule (composer-width)
//     <cwd> … shift+tab agents  ctrl+p commands   <- status rows BELOW the rule (chrome, not content)
//
// The agent's live run (tool output, a spinner row, hint rows) paints INSIDE the same bar run, above
// the draft — so the bar run is NOT "the composer" the way omp's box is; only its TAIL is composer
// chrome and the strip below cuts exactly that tail. Everything here is therefore anchored at the
// buffer tail, and every predicate can only ever REJECT.

import { isBlank, lineText } from "../../blocks";

// `lineText` / `isBlank` are properties of a StyledLine, not of any grammar — they live in the
// neutral core (lib/blocks.ts). Re-exported here so the opencode grammars keep their single import
// site, the same arrangement every other adapter uses.
export { isBlank, lineText };

/** Drop TRAILING whitespace only. opencode pads every composer row out to the terminal's column
 *  count, so the bar's closing pad run follows every real glyph; an anchored `…$` regex would never
 *  match without this. Leading whitespace is NOT dropped: the bar's column is the composer's own
 *  left edge and the scanners read structure off the row's SHAPE, not its indent. */
export function rstrip(text: string): string {
  return text.replace(/\s+$/, "");
}

/** The composer's LEFT BAR — U+2503 (heavy vertical). Light U+2502 (`│`) is deliberately excluded:
 *  Claude's boxes are drawn with it, and a foreign buffer must never match. */
export const BAR = "┃";

// The composer interior row: optional leading pad, then the bar as the row's FIRST glyph. opencode
// pads its rows out to the full terminal width, so nothing else carries a leading ┃ — the transcript
// is indented without one (capture census: every ┃ row in the corpus is composer interior, and no
// transcript row opens with one).
const BAR_ROW = /^\s*┃/;

/** True when this row is a composer interior row (the bar as the first glyph after the pad). */
export function isBarRow(text: string): boolean {
  return BAR_ROW.test(rstrip(text));
}

// The composer's BOTTOM RULE: U+2579 (╹) then a run of U+2580 (▀ upper-half blocks). Across the
// corpus it appears once per composer frame, always directly under the model row, spanning the
// composer's own width — no other opencode chrome draws it. The ▀ run is what other rule-like rows
// lack; ╹ alone would be too thin an anchor to carry the claim.
const RULE_ROW = /^\s*╹▀+$/;

/** True when this row is the composer's bottom rule. The anchor every tail walk hangs off. */
export function isRuleRow(text: string): boolean {
  return RULE_ROW.test(rstrip(text));
}

// The model row: the LAST interior row, `┃  <agent> · <model>[ · <variant>]`. Two or three
// dot-separated fields, the separators painted as ` · ` (U+00B7 middle dot with spaces). This is a
// SHAPE check, not a catalogue: the agent name is open-ended (opencode ships custom agents), so the
// predicate requires dot-separated non-empty fields and nothing more specific. A draft that itself
// contains ` · ` cannot be mistaken for it — the model row is only ever read as the row DIRECTLY
// above the rule, a position a draft row never reaches.
const MODEL_ROW = /^\s*┃\s{2}\S[\s\S]*? · \S/;

/** True when this row could be the model row (the composer's last interior row). Positional checks
 *  elsewhere do the real work; this is the sanity half. */
export function isModelRow(text: string): boolean {
  return MODEL_ROW.test(rstrip(text));
}

// The draft sits on interior rows with a TWO-SPACE gutter after the bar — the same arrangement the
// wrapped continuations use, so the draft run is read by gutter, not by position.
const BAR_GUTTER = new RegExp(`^\\s*${BAR}  ([\\s\\S]*)$`);

/** The draft text carried by an interior row (UNTRIMMED — the fold seam is decided by the caller),
 *  or null when the row is not a two-space-gutter interior row. */
export function barDraftText(text: string): string | null {
  const m = BAR_GUTTER.exec(rstrip(text));
  return m === null ? null : m[1]!;
}

// opencode's empty-composer placeholder. It is painted CONTENT — the row looks exactly like a typed
// draft — so the draft probe must be able to refuse it. The prefix is opencode's own default
// placeholder ("Ask anything…"); a user draft that BEGINS with that exact sentence reads as no draft,
// which stalls a send rather than firing a wrong Enter — the fail-safe direction. No wider
// allow-list is invented for it.
const PLACEHOLDER_PREFIX = "Ask anything";

/** True when a draft candidate's text is actually the placeholder painted for an empty box. */
export function isPlaceholder(text: string): boolean {
  return text.trimStart().startsWith(PLACEHOLDER_PREFIX);
}

/** The dialog's title glyph — U+25B3 (△) — opens the permission dialog's title row. */
const TITLE_ROW = /^\s*┃\s{2}△ Permission required$/;

/** True when this row is the permission dialog's title row. Content-anchored on purpose: it is the
 *  one row the dialog always paints, and the lift refuses without it. */
export function isPermissionTitle(text: string): boolean {
  return TITLE_ROW.test(rstrip(text));
}

// The option footer's own affordance names, painted after the option chips on the same row (wide)
// or on a row of their own beneath the options (narrow). These literals are the dialog's own key
// hints — the recipe is read off the screen, never inferred — and they are the tail anchor: no
// other opencode row carries both.
export const SELECT_HINT = "⇆ select";
export const CONFIRM_HINT = "enter confirm";

/** True when this row carries the dialog footer's select+confirm hint pair (the whole footer, or
 *  the hint row alone at narrow widths). */
export function hasFooterHints(text: string): boolean {
  return rstrip(text).includes(SELECT_HINT) && rstrip(text).includes(CONFIRM_HINT);
}
