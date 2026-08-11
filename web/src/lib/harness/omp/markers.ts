// Shared lexing helpers over the parsed `StyledLine[]` — the primitives omp's chrome stripping leans
// on, and where a future omp grammar would add its own. Same methodology as harness/claude/markers.ts
// and deliberately NOT the same code: an adapter that imported another adapter's predicates would
// inherit that harness's renderer archaeology, and the two TUIs draw nothing the same way. They
// operate on the *parsed* line text (segment text joined), never the raw ANSI bytes: SGR codes sit
// *between* glyphs, so a regex over the raw buffer would miss (omp paints a border's corner and the
// statusline inside it as separate styled segments). Pure functions, no I/O, no React.

import { isBlank, lineText } from "../../blocks";

// `lineText` / `isBlank` are properties of a StyledLine, not of any grammar, so they live in the
// neutral core (lib/blocks.ts). Re-exported here so the omp grammars keep their single import site —
// the same arrangement claude/markers.ts uses, for the same reason.
export { isBlank, lineText };

/**
 * Drop TRAILING whitespace only. Every one of omp's box rows is padded out to the terminal's full
 * column count, so the closing glyph of a border is followed by nothing on a real capture but by a
 * run of spaces in the buffer — an anchored `…$` regex would never match without this. Leading
 * whitespace is deliberately NOT dropped: `composerContText` distinguishes a wrapped-draft row from
 * ordinary boxed output by its exact two-space gutter, and lstripping would erase that evidence.
 */
export function rstrip(text: string): string {
  return text.replace(/\s+$/, "");
}

// The composer's TOP border: a rounded corner, at least one rule glyph, then anything (omp paints the
// user's whole statusline INTO this border — see chrome.ts), closed by the opposite corner. Loose ON
// PURPOSE, and it earns that looseness exactly the way claude/markers.ts's `isInputBoxTopBorder` earns
// its 1-glyph flanks: it is the LAST thing `locateComposer` checks, at a row already pinned by the
// bottom border, the continuation walk and a display-width equality against that bottom border. On its
// own it would happily claim omp's welcome box and every `/model` / `/settings` / Ask panel — all of
// which are narrower than the composer and none of which is ever adjacent to a `╰─ … ─╯` row.
const COMPOSER_TOP = /^╭─+.*╮$/;

/** True when the line could be the composer box's top border. Never decisive alone — see above. */
export function isComposerTop(text: string): boolean {
  return COMPOSER_TOP.test(rstrip(text));
}

// The composer's BOTTOM border, and the single most load-bearing literal in this adapter: omp writes
// the LAST fragment of the draft INTO the bottom border, between a `╰─ ` opener and a ` ─╯` closer, so
// the border carries a one-space gutter on each side that nothing else in the TUI has. Across the
// whole 58-fixture corpus (38 claude + 20 omp) this shape occurs exactly ONCE per composer capture and
// nowhere else: every other omp box — the welcome panel, a tool-result box, an Ask dialog, `/model`,
// `/settings` — closes corner-to-corner with an unbroken rule (`╰────╯`) and no gutter. That is why
// the composer gate can be lexical here where Claude's had to be positional.
const COMPOSER_BOTTOM = /^╰─ (.*) ─╯$/;

/** The draft tail written into the composer's bottom border (UNTRIMMED — the caller decides), or null
 *  when the line is not that border. An empty composer yields `""`, which is a match, not a miss. */
export function composerBottomText(text: string): string | null {
  const m = COMPOSER_BOTTOM.exec(rstrip(text));
  return m === null ? null : m[1]!;
}

// A wrapped draft's CONTINUATION row: the box's vertical sides with a two-space gutter inside each.
// The gutter is what separates it from every other `│ … │` row omp draws (the welcome panel's columns,
// `/model`'s provider list, an Ask dialog's body) — but it is not asked to carry that weight alone
// either: `locateComposer` only ever tests rows that sit directly above an already-matched
// `╰─ … ─╯` bottom border and share its display width.
const COMPOSER_CONT = /^│ {2}(.*) {2}│$/;

/** The text of a wrapped-draft continuation row (UNTRIMMED), or null when the line is not one. */
export function composerContText(text: string): string | null {
  const m = COMPOSER_CONT.exec(rstrip(text));
  return m === null ? null : m[1]!;
}
