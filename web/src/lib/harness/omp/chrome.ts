// Chrome stripping for omp — trims the agent's own TUI composer off the TAIL of a parsed buffer so
// the app's composer/statusline supersedes it instead of duplicating it, and re-surfaces the two
// things that strip would otherwise destroy (the statusline and a stranded draft).
//
// NONE of harness/claude/chrome.ts transfers, because omp inverts Claude's layout in three ways:
//
//   Claude                                    omp
//   ──────────────────────────────────        ────────────────────────────────────────────
//   ┌ top border (plain rule)                 ╭── <THE STATUSLINE lives IN this border> ──╮
//   │ ❯ <first line of the draft>             │  <earlier draft fragments>                │
//   │   <wrapped continuations below it>      ╰─ <the LAST draft fragment> ───────────────╯
//   └ bottom border                           ❯ <slash-palette rows, painted BELOW the box>
//     <statusline rows, painted BELOW>
//
// So the draft folds the other way, the statusline is a BORDER rather than a run of rows under one,
// and the autocomplete sits below the box instead of above it. What DOES transfer is the shape of the
// thing: one private bottom-up scanner that pins the whole box before anyone reads a field off it,
// four thin probes over it, hard caps on every walk, and a conservatism contract that returns the
// input untouched when the shape doesn't fully match. Pure; no pane access, no network.

import type { StyledLine } from "../../blocks";
import { displayWidth } from "../../text-width";
import {
  composerBottomText,
  composerContText,
  isBlank,
  isComposerTop,
  lineText,
  rstrip,
} from "./markers";

// Rows omp may paint BELOW the composer box: the slash palette (`/` autocomplete) and its kin. Bounded
// so a torn or foreign buffer can't reach an arbitrarily distant `╰─ … ─╯` and claim everything under
// it as chrome.
//
// 64 is chosen to be UNREACHABLE by a real palette rather than to be tight. omp renders the palette
// into the viewport, so its true ceiling is the pane's own height, and the tallest capture in this
// corpus is 59 rows (omp--select-multi*.txt); anything at or under that must not trip the cap. The
// observed palettes are far smaller — 3 rows (one wrapped entry) and 5 rows (five commands) — but
// sizing the constant to what was observed is the mistake to avoid here, because being too LOW is not
// the safe direction:
//
//   too low  ⇒ locateComposer returns null on a perfectly ordinary screen ⇒ stripChrome leaves omp's
//              composer duplicated in the mirror AND `composerReady` answers false, so the reply
//              pre-flight refuses the send with "a menu or dialog is probably up" when none is.
//   too high ⇒ costs nothing on its own. The cap is defence in depth, not the guard: every row
//              between the candidate bottom border and the tail must ALSO be non-blank and match the
//              box's display width exactly (see step (a)), and ragged real transcript fails that on
//              the first row. The cap only stops the *search* from walking a 10,000-line scrollback.
//
// So: raise this without ceremony if a taller pane is ever seen; lower it only with a capture that
// shows the width check failing to hold the line on its own.
const MAX_SUGGESTION_ROWS = 64;

// A long draft WRAPS onto continuation rows ABOVE the bottom border. Same defense-in-depth role — and
// the same number — as claude/chrome.ts's MAX_DRAFT_LINES: the caller's read window defaults to 200
// lines and is client-requestable up to 10,000, so an unbounded walk would let a stray `│  … │` row
// pair with an unrelated `╭─…─╮` hundreds of lines further up. Note what this cap does NOT have to
// bound: there is no free `while (isBlank) i--` skip anywhere in the walk below. claude/chrome.ts
// records what a second, uncapped blank skip cost — a wall of blank padding stood in for the filler
// the cap exists to bound and reached an arbitrarily distant border. omp pads its box rows to the full
// terminal width, so a blank row inside the box is not a shape it can draw; a blank simply ends the
// walk, and the cap is the only budget.
const MAX_DRAFT_ROWS = 100;

/** The composer box located at the buffer's tail. Every index is into the ORIGINAL `lines` array. */
export interface ComposerBox {
  /** The TOP border row. It IS omp's statusline: the powerline fields are painted into the border. */
  top: number;
  /** First draft row = `top + 1`. Equals `bottom` when the draft fits on one row (the common case). */
  firstDraftRow: number;
  /** The `╰─ … ─╯` row — which carries the LAST fragment of the draft, not chrome below it. */
  bottom: number;
  /** EXCLUSIVE end of the autocomplete run painted BELOW the box (`bottom + 1` when there is none). */
  suggestEnd: number;
  /** The box's display width in CELLS, derived from the box itself — never a constant. Every row of
   *  the box is checked against it, which is what stops a lookalike row from a different panel (omp
   *  draws several, all narrower) from being spliced into this one. */
  width: number;
}

/**
 * Locate omp's composer box at the tail of `lines`, or null. Bottom-up, four steps, each of which can
 * only ever REJECT — there is no branch that widens the claim.
 *
 *     ╭── <statusline> ───╮      (c) top border, at the box's own width
 *     │  <draft row…>     │      (b) 0..MAX_DRAFT_ROWS continuation rows, at the box's own width
 *     ╰─ <draft tail> ────╯      (a) the bottom border — the anchor everything else is measured from
 *     ❯ <palette row…>           (a) 0..MAX_SUGGESTION_ROWS rows below it, at the box's own width
 */
export function locateComposer(lines: StyledLine[]): ComposerBox | null {
  const texts = lines.map((l) => rstrip(lineText(l)));
  let end = texts.length - 1;
  while (end >= 0 && isBlank(texts[end]!)) end--;
  if (end < 0) return null;

  // (a) The bottom border, and the autocomplete run (if any) omp painted below it. The run is matched
  //     POSITIONALLY — nothing here reads a palette row's content, because those rows are model- and
  //     user-authored text. What makes that safe is the width equality: omp draws the palette at the
  //     box's own width, so a row of a DIFFERENT width is ordinary output that has scrolled the box
  //     up, and claiming it would strip the user's transcript off the mirror.
  let bottom = -1;
  if (composerBottomText(texts[end]!) !== null) {
    bottom = end;
  } else {
    for (let k = end - 1; k >= 0 && end - k < MAX_SUGGESTION_ROWS; k--) {
      if (composerBottomText(texts[k]!) !== null) {
        bottom = k;
        break;
      }
    }
    if (bottom < 0) return null;
    for (let row = bottom + 1; row <= end; row++) {
      if (isBlank(texts[row]!)) return null;
      if (displayWidth(texts[row]!) !== displayWidth(texts[bottom]!)) return null;
    }
  }
  const width = displayWidth(texts[bottom]!);
  const suggestEnd = end + 1;

  // (b) Continuation rows of a wrapped draft, walking up from the bottom border. Every row must BOTH
  //     carry the two-space gutter and match the box's width — the gutter alone is a shape several of
  //     omp's other panels also draw.
  let i = bottom - 1;
  while (
    i >= 0 &&
    bottom - i <= MAX_DRAFT_ROWS &&
    composerContText(texts[i]!) !== null &&
    displayWidth(texts[i]!) === width
  ) {
    i--;
  }

  // (c) The top border — the LAST anchor checked, which is what pays for `isComposerTop` being loose
  //     (see markers.ts). By now the bottom border, the continuation walk and the cap have pinned the
  //     rest of the shape, and the width equality closes it: omp's welcome panel and its pickers all
  //     open with `╭─…─╮` too, at 100 cells against this box's 189.
  if (i < 0 || !isComposerTop(texts[i]!) || displayWidth(texts[i]!) !== width) return null;

  return { top: i, firstDraftRow: i + 1, bottom, suggestEnd, width };
}

/**
 * Return `lines` with the composer box (and anything omp painted below it) removed from the tail.
 * When nothing matches the input is returned as-is (SAME REFERENCE), so callers can treat an
 * unchanged result as "no chrome" — the same conservatism contract claude/chrome.ts publishes.
 *
 * Because the box and its autocomplete run always sit at the tail, cutting at `box.top` removes the
 * slash palette along with the box. That is deliberate, not incidental: the palette is composer
 * chrome, and collie draws its own for an omp pane — lib/agent-commands.ts carries an `omp` catalog,
 * and composer.tsx renders the palette button whenever `commandsFor(agent)` is non-empty — so
 * mirroring omp's would draw it twice. That catalog is the load-bearing half of the sentence, and it
 * had to be added alongside this strip: while `commandsFor("omp")` still returned `[]` the button was
 * hidden, so cutting here took omp's own palette off the mirror and handed the user nothing back.
 * Collie's catalog is curated from the WHOLE corpus rather than mirroring this one pane's palette —
 * that palette is only what omp fuzzy-matched for one search string — and the rows omp assembles from
 * the user's own machine (its `skill:…` entries) are not in it.
 */
export function stripChrome(lines: StyledLine[]): StyledLine[] {
  const texts = lines.map((l) => rstrip(lineText(l)));
  let end = lines.length; // exclusive bound of the kept range

  // 1. Drop a trailing run of blank lines.
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return lines.slice(0, 0);

  // 2. Peel the composer off the tail if the full shape is present. Only then; otherwise the
  //    blank-trim above is the sole (safe) change.
  const box = locateComposer(lines);
  if (box !== null) {
    end = box.top;
    // Drop the blank run now exposed above the box (omp leaves one between transcript and composer).
    while (end > 0 && isBlank(texts[end - 1]!)) end--;
  }

  return end === lines.length ? lines : lines.slice(0, end);
}

// Segments to shave off the START of the statusline border: the corner + rule run omp opens it with,
// and the space that follows. A GLYPH-CLASS rule, the same class of thing as a border predicate — not
// a field parser. Nothing here reads `π`, `⬢`, `🗑`, `⑂`, `◫` or `(sub)`, because the fixture corpus
// README says outright that chrome varies per install and warns against anchoring on one exact
// string: every one of those glyphs is user-configurable in omp's statusline template.
const LEADING_BORDER_SEGMENT = /^[╭╰─\s]*$/;
// …and off the END: the closing rule run and its corner.
const TRAILING_BORDER_SEGMENT = /^[─╮╯\s]*$/;
// Nothing but border and whitespace left — the shape a user who turned their statusline off leaves
// behind. Applied to the SURVIVORS' joined text rather than per segment, because a row omp painted in
// one colour arrives as a single segment carrying both corners, which neither one-ended trim can peel.
const BORDER_ONLY = /^[╭╮╰╯─│\s]*$/;

/**
 * Shave the border glyphs off a statusline row, keeping every surviving segment STYLED.
 *
 * Returns a StyledLine without `noWrap`: that flag marks a row as a known terminal-width border to be
 * kept on one visual line, and once the border is gone this row is ordinary (narrow) content that
 * should wrap like the rest of the strip.
 */
function trimBorderSegments(line: StyledLine): StyledLine {
  let from = 0;
  let to = line.segments.length;
  while (from < to && LEADING_BORDER_SEGMENT.test(line.segments[from]!.text)) from++;
  while (to > from && TRAILING_BORDER_SEGMENT.test(line.segments[to - 1]!.text)) to--;
  const kept = line.segments.slice(from, to);
  return { segments: BORDER_ONLY.test(kept.map((s) => s.text).join("")) ? [] : kept };
}

/**
 * omp's statusline — the powerline strip (`π  > ⬢ <model> > 🗑 <cwd> > ⑂ <branch> > ◫ <ctx> > (sub) ▶`)
 * that omp paints INTO the composer box's top border. stripChrome peels that border off the mirror,
 * so this re-surfaces it as app chrome above the composer instead of losing it.
 *
 * Found by POSITION (it is the box's top row, whatever it says) and tolerated by SHAPE (the border
 * glyphs are trimmed by glyph class), never by CONTENT. Returns one row, or `[]` when there is no box
 * at the tail (a dialog owns the screen, or the buffer is foreign/torn) — and also `[]` when the user
 * has configured the statusline away entirely, since a bare `╭────╮` trims to nothing. The strip then
 * simply hides, which is the honest answer.
 *
 * Rows stay STYLED because omp colours each powerline field separately (brand cyan for the model, green
 * for the branch, grey for the context meter, all on its own dark background); flattening to text one
 * call before the surface that renders it is what makes the strip unreadable at a glance.
 */
export function extractStatusLines(lines: StyledLine[]): StyledLine[] {
  const box = locateComposer(lines);
  if (box === null) return [];
  const row = trimBorderSegments(lines[box.top]!);
  return row.segments.length === 0 ? [] : [row];
}

/**
 * The user's draft text stranded in the composer box. omp keeps a typed-but-unsent message there
 * across turns, and stripChrome peels the whole box off the mirror, so without this it becomes
 * invisible and the app's composer (local state only) never learns of it.
 *
 * Folds the OPPOSITE way from Claude's: omp writes the LAST fragment into the bottom border and stacks
 * the EARLIER ones above it, so the parts are read top-down from `firstDraftRow` and the bottom border
 * contributes the tail. Fragments are joined with a single space — omp soft-wraps at word boundaries,
 * so the break it removed was one.
 *
 * There is NO placeholder allow-list, and one must not be invented: omp paints nothing at all in an
 * empty composer (verified across every idle capture in the corpus), so an empty box yields `""` and
 * this returns null. `null` also covers "no box at the tail".
 *
 * Load-bearing beyond the preview: once the adapter is registered, reply-action.ts switches omp panes
 * from the legacy one-shot send to type-then-verify, and THIS is the verify half — a wrong answer
 * stalls every free-text send with "Message didn't reach the input box".
 */
export function extractInputDraft(lines: StyledLine[]): string | null {
  const box = locateComposer(lines);
  if (box === null) return null;
  const texts = lines.map((l) => rstrip(lineText(l)));

  const parts: string[] = [];
  for (let i = box.firstDraftRow; i < box.bottom; i++) {
    parts.push(composerContText(texts[i]!)!.trim());
  }
  parts.push(composerBottomText(texts[box.bottom]!)!.trim());

  const draft = parts.filter((p) => p.length > 0).join(" ");
  return draft.length === 0 ? null : draft;
}

/**
 * Whether omp's free-text composer is on screen at the tail — i.e. whether typing a reply would land
 * in the input box at all, rather than in a modal that has the keyboard.
 *
 * This is the highest-leverage function in the adapter. Before it existed, `omp` had no adapter at
 * all, so `sendGuardedReply` took the legacy one-shot path: type AND submit in a single call. A user
 * replying from their phone while one of omp's modals held the keyboard therefore fired the submit
 * key at THAT modal — the text is swallowed and the key confirms whatever row the modal had
 * highlighted. A definite `false` here is what makes the reply pre-flight refuse before a byte is
 * typed, and every capture in this corpus with a modal on screen answers `false` (chrome.test.ts).
 */
export function hasComposer(lines: StyledLine[]): boolean {
  return locateComposer(lines) !== null;
}
