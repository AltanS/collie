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
// bottom border, the continuation walk and the caps on both. Nothing measures it — chrome.ts records
// why a width equality against the bottom border is unsound — so the adjacency is the whole claim. On
// its own this predicate would happily claim omp's welcome box and every `/model` / `/settings` / Ask
// panel; what keeps them out is that none of them is ever adjacent to a `╰─ … ─╯` row.
// `[\s\S]*`, never `.*`, in all three row predicates below. A dot is not "any glyph": JS excludes
// `\n`, `\r`, **U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR** from it. The first two can
// never reach here (splitLines cut on them), but the separators can: `rstrip` only takes them off the
// END of a row, so one anywhere else in a statusline template or a typed message survives into
// `lineText` and silently declines the row. That is a CHARACTER-CLASS gate — exactly the kind of
// silent measurement chrome.ts deleted the width comparisons to be rid of — and it fails in the worst
// direction: locateComposer returns null on every frame, so the statusline and draft vanish, the box
// stays duplicated on the mirror, and `composerReady` refuses every reply while no dialog exists.
// Nothing on the send path normalises text, and U+2028 rides in on a paste from a PDF, a Word
// document or a JS string literal, so the operator can put one in their own message today.
const COMPOSER_TOP = /^╭─+[\s\S]*╮$/;

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
const COMPOSER_BOTTOM = /^╰─ ([\s\S]*) ─╯$/;

/** The draft tail written into the composer's bottom border (UNTRIMMED — the caller decides), or null
 *  when the line is not that border. An empty composer yields `""`, which is a match, not a miss. */
export function composerBottomText(text: string): string | null {
  const m = COMPOSER_BOTTOM.exec(rstrip(text));
  return m === null ? null : m[1]!;
}

// A wrapped draft's CONTINUATION row: the box's vertical sides with a two-space gutter inside each.
// The gutter is what separates it from every other `│ … │` row omp draws (the welcome panel's columns,
// `/model`'s provider list, an Ask dialog's body) — but it is not asked to carry that weight alone
// either: `locateComposer` only ever walks rows in an unbroken run directly above an already-matched
// `╰─ … ─╯` bottom border, capped, and terminating on a row its top-border check has to accept.
const COMPOSER_CONT = /^│ {2}([\s\S]*) {2}│$/;

/** The text of a wrapped-draft continuation row (UNTRIMMED), or null when the line is not one. */
export function composerContText(text: string): string | null {
  const m = COMPOSER_CONT.exec(rstrip(text));
  return m === null ? null : m[1]!;
}

// A row that OPENS A BOX at column 0 — the single shape every widget omp can put in front of the
// composer is built out of. Every one of the eleven modal captures in this corpus (`/model`,
// `/settings`, `/resume` and their moved-selection twins; the five Ask-tool screens) draws a full
// box whose every row starts here: `╭` for the header, `│` for a body row, `├` for an internal rule,
// `╰` for the footer. So does the welcome panel, the tool-result box, and the `╭─── ✘ Error: … ───╮`
// banner. omp indents ordinary transcript by one column and paints the slash palette's rows with a
// `❯ ` marker or a two-space gutter, so column 0 carries a box-drawing glyph only when omp is drawing
// a BOX there — which is why this can be a glyph predicate rather than a content match.
//
// The whole Unicode Box Drawing block is claimed, not just omp's four corners: this predicate's job
// is to REJECT, so being generous is the fail-closed direction (a rejected row costs a null, i.e. a
// refused send, and never a key), and a renderer that swapped its rounded corners for square ones
// must not silently escape it.
const BOX_ROW = /^[─-╿]/; // the Box Drawing block, entire

/**
 * True when this row is a box being drawn at column 0. Used by `locateComposer` to refuse a composer
 * that has another of omp's boxes UNDER it — see the tail-anchor note in chrome.ts. Deliberately
 * blind to what the box says: an Ask dialog, a picker and an error banner are all equally
 * disqualifying, and none of them should have to be recognised individually to say so.
 */
export function opensBox(text: string): boolean {
  return BOX_ROW.test(rstrip(text));
}
