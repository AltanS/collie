// Shared lexing helpers over the parsed `StyledLine[]` — the primitives omp's chrome stripping leans
// on, and where a future omp grammar would add its own. Same methodology as harness/claude/markers.ts
// and deliberately NOT the same code: an adapter that imported another adapter's predicates would
// inherit that harness's renderer archaeology, and the two TUIs draw nothing the same way. They
// operate on the *parsed* line text (segment text joined), never the raw ANSI bytes: SGR codes sit
// *between* glyphs, so a regex over the raw buffer would miss (omp paints a border's corner and the
// statusline inside it as separate styled segments). Pure functions, no I/O, no React.

import { isBlank, lineText, type StyledLine } from "../../blocks";

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

// OMP 17's classic composer writes the LAST fragment of the draft into a closed bottom border,
// between a `╰─ ` opener and a ` ─╯` closer. OMP 18.1.2 can clip the right chrome entirely on a wide
// pane and leave the same prompt row open-ended (`╰─ draft` or bare `╰─`). Both forms keep the
// discriminator that other OMP boxes lack: after `╰─` comes either a one-space draft gutter or the
// end of the row, never another rule glyph.
const COMPOSER_BOTTOM = /^╰─ ([\s\S]*) ─╯$/;
const OPEN_COMPOSER_BOTTOM = /^╰─(?: ([\s\S]*))?$/;
/** Both supported composer rows share this opener; the draft span begins immediately after it. */
const BOTTOM_OPEN = "╰─ ";

interface ParsedComposerBottom {
  draft: string;
  openEnded: boolean;
}

function parseComposerBottom(text: string): ParsedComposerBottom | null {
  const stripped = rstrip(text);
  const closed = COMPOSER_BOTTOM.exec(stripped);
  if (closed !== null) return { draft: closed[1]!, openEnded: false };
  const open = OPEN_COMPOSER_BOTTOM.exec(stripped);
  return open === null ? null : { draft: open[1] ?? "", openEnded: true };
}

/** The draft tail written into either composer row (UNTRIMMED), or null for every other box bottom. */
export function composerBottomText(text: string): string | null {
  return parseComposerBottom(text)?.draft ?? null;
}

/** Whether OMP clipped the row's right chrome — this shape has no separate top border to require. */
export function isOpenComposerBottom(text: string): boolean {
  return parseComposerBottom(text)?.openEnded === true;
}

// omp paints an INLINE COMPLETION SUGGESTION — a "ghost" — into the composer, after the operator's
// own text: unaccepted, absent from the input buffer, and deleted by no Backspace. Live capture
// (sandbox omp pane, 2026-08-23, omp 17) of the bottom border after typing `leftover draft here`:
//
//   ESC[38;2;190;149;255m╰─ ESC[0mleftover draft hereESC[0mESC[38;2;111;115;119m'sESC[0m … ─╯
//
// and the same row on omp 18.0.11 (2026-08-30) after typing `list the files in this repo` while the
// agent was WORKING — the draft now carries an explicit foreground of its own:
//
//   ESC[38;2;250;81;53m╰─ ESC[38;2;242;244;248mlist the files in this repoESC[38;2;111;115;119mrtESC[0m … ─╯
//
// That one rendering detail cost omp panes their whole reply path: `extractInputDraft` read back
// `leftover draft here's`, `draftCarriesSend` (lib/reply-action.ts) requires the visible draft to be
// CONTAINED in what was typed, `'s` is not — so the submit key was withheld and every send stalled
// with "Message didn't reach the input box" while the message really was in the box. Each retry
// re-typed, omp re-suggested, and the stall repeated forever.
//
// The rule below is RELATIVE and names no colour, because every colour here is a theme value. The
// first version anchored on the draft being UNSTYLED, which is what omp 17 did and what omp 18 still
// does on an IDLE pane — but on a working pane omp 18 writes the same text in an explicit theme
// foreground, that anchor vanished, and the stall came back verbatim. So a ghost is now "the trailing
// run of segments sharing ONE foreground that DIFFERS from the text before it", which reads both
// shapes: the draft's colour is whatever precedes the run, present or absent. The caller supplies the
// exact draft span from an already-located composer row: the boxed scanner uses its bottom border;
// the rule scanner uses its final prompt row. This helper is deliberately not a border predicate.
//
// Three refusals, all the fail-closed direction, because a wrongly-claimed ghost SHORTENS the draft
// the reply guard verifies: a row painted in ONE foreground end to end claims nothing (that is the
// shape a row omp coloured wholesale arrives as), a row whose trailing run has NO foreground claims
// nothing (omp's suggestion always carries one, and an unstyled tail after a coloured head is far
// more likely to be the operator's own text), and a run with nothing but blanks before it claims
// nothing.
//
// What the rule still gets WRONG, bounded and deliberately left: omp decorates some text the operator
// really typed — the magic keywords (`ultrathink`, `workflowz`) come back as a per-character colour
// GRADIENT, and `[Image #1]` / `[Paste #1]` placeholders come back in the accent colour. A draft
// ENDING in one of those has its last colour run claimed, which for a gradient is a single character.
// Two things bound the damage. It cannot change a send verdict: `draftCarriesSend` accepts any
// contiguous run of the draft's visible characters inside what was typed (MIN_MATCH_CHARS floor
// aside), so a draft that was already contained stays contained after a character comes off the end,
// and a draft that was NOT contained is the ghost case this exists for. What it does cost is the
// stranded-draft preview: "Take over" can hand back a draft one character short. Tightening the other
// way — refusing a tail that changes colour more than once — was measured against this and rejected:
// it puts every `@mention`- or placeholder-ending draft back into the permanent stall, which is the
// failure the operator actually feels. The previous rule was WORSE here, not better: with an unstyled
// draft it claimed the whole gradient (`ultrathink`), where this one claims `k`.
/** The trailing inline-suggestion run inside an already-located draft span. */
export function draftGhost(line: StyledLine, start: number, end: number): string {
  if (end <= start) return "";

  // The row's segments clipped to the draft span, so surrounding chrome cannot be mistaken for a
  // suggestion.
  const parts: { text: string; fg: string | undefined }[] = [];
  let at = 0;
  for (const seg of line.segments) {
    const from = Math.max(at, start);
    const to = Math.min(at + seg.text.length, end);
    if (to > from) {
      parts.push({ text: seg.text.slice(from - at, to - at), fg: seg.fg });
    }
    at += seg.text.length;
    if (at >= end) break;
  }

  // OMP pads the row out to the terminal's width in the default style, so that padding is neither
  // draft nor suggestion — drop it before looking for the trailing run.
  while (parts.length > 0 && parts[parts.length - 1]!.text.trim() === "") parts.pop();
  if (parts.length === 0) return "";

  const ghostFg = parts[parts.length - 1]!.fg;
  if (ghostFg === undefined) return "";
  let cut = parts.length;
  while (cut > 0 && parts[cut - 1]!.fg === ghostFg) cut--;
  if (cut === 0) return "";
  if (!parts.slice(0, cut).some((part) => part.text.trim() !== "")) return "";
  return rstrip(
    parts
      .slice(cut)
      .map((part) => part.text)
      .join(""),
  );
}

/** The boxed composer's specialization: locate its draft span, then apply the shared ghost rule. */
export function composerGhost(line: StyledLine): string {
  const inner = parseComposerBottom(lineText(line))?.draft;
  if (inner === undefined || inner.length === 0) return "";
  const start = BOTTOM_OPEN.length;
  return draftGhost(line, start, start + inner.length);
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
