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
import {
  composerBottomText,
  composerContText,
  composerGhost,
  isBlank,
  isComposerTop,
  isOpenComposerBottom,
  lineText,
  opensBox,
  rstrip,
} from "./markers";

// Rows omp may paint BELOW the composer box: the slash palette (`/` autocomplete) and its kin. Bounded
// so a torn or foreign buffer can't reach an arbitrarily distant `╰─ … ─╯` and claim everything under
// it as chrome.
//
// 64 is chosen to be UNREACHABLE by a real palette rather than to be tight. omp renders the palette
// into the viewport (its rows carry a scrollbar column, so the list is a window onto a longer one),
// which makes its true ceiling the pane's own height; the tallest capture in this corpus is 59 rows
// (omp--select-multi*.txt). What is actually OBSERVED below a bottom border is far smaller — 5 rows
// (`omp--slash-palette--filtered.txt`), 3 rows (`omp--slash-palette.txt`), and 0 in the other seven
// composer captures — but sizing the constant to what was observed is the mistake to avoid here,
// because being too LOW is not the safe direction:
//
//   too low  ⇒ locateComposer returns null on a perfectly ordinary screen ⇒ stripChrome leaves omp's
//              composer duplicated in the mirror AND `composerReady` answers false, so the reply
//              pre-flight refuses the send with "a menu or dialog is probably up" when none is.
//   too high ⇒ the run below the bottom border is claimed as composer chrome and cut from the mirror
//              with the box, so this bounds how much a TORN frame (a composer scrolled up with real
//              transcript beneath it — a shape no capture in the corpus shows) can cost.
//
// Being generous here is only defensible because the cap is NOT what separates a composer from a
// modal — `opensBox` is (see step (a)). The distance from the bottom border to the tail was never the
// interesting quantity: what makes a screen unsafe to type into is another of omp's boxes sitting in
// front of the composer, and that is now a glyph predicate on every row of the run rather than an
// arithmetic bound on how many of them there are. Read this constant as the bound on how much TORN
// TRANSCRIPT the strip may eat, which is the cosmetic cost it really governs — raise it without
// ceremony if a taller palette is ever seen, and lower it only with a capture that shows the run being
// over-claimed in a way that matters.
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

// WHY THERE IS NO WIDTH COMPARISON ANYWHERE IN THIS FILE — and why one must not come back.
//
// The obvious way to pin a box is to require its rows to measure the same: omp pads every row of the
// composer out to the terminal's column count, so on screen they are a perfect rectangle. This
// scanner shipped that twice — first as `displayWidth(a) === displayWidth(b)`, then as an equality
// slackened by a per-cluster "error bar" (`widthUncertainty`, since deleted). Both are unsound, for
// one reason: omp padded those rows with ITS width table, we re-measure with OURS, and the two rows
// carry DIFFERENT content — the user's statusline template on the top border, their draft tail on the
// bottom one — so the comparison only ever held when both tables happened to agree about both
// strings. text-width.ts is documented as an approximation of `wcwidth`; a detector may not depend on
// that approximation being exact.
//
// The error is also unbounded from inside. `displayWidth` walks Intl.Segmenter grapheme clusters and
// scores each by its BASE code point; every width table a TUI actually links against (wcwidth,
// go-runewidth, Rust unicode-width) sums a cluster's code points independently. `👨‍💻` is 2 for us and
// 4 for them, `👨‍👩‍👧‍👦` 2 against 8, and a keycap (`1` + VS16 + U+20E3) is 1 against 2. The error bar
// was built from these same range tables, so it could not see any of that and scored all three as
// CERTAIN — it read ZERO exactly where the divergence was largest — while `🗑`, `▶` and every arrow
// scored as doubtful and donated slack the check had no business spending (forty arrows typed into a
// message bought the TOP border forty columns of drift).
//
// The failure it buys is total and permanent, and it is the one MAX_SUGGESTION_ROWS' comment names as
// the unsafe direction: one ZWJ emoji in a user's statusline template, or typed into their own
// message, and locateComposer returns null on EVERY frame — no statusline strip, no draft chip,
// `composerReady` false forever, and every reply refused with "the input box isn't on screen" while no
// dialog exists.
//
// Against that, the check was never what discriminated. Across the whole 59-capture corpus the
// `╰─ … ─╯` bottom border occurs exactly ONCE in each of the 10 composer captures and NOWHERE else:
// zero occurrences in the 11 modal captures (`/model`, `/settings`, resume, select, multi-select),
// zero in the welcome panel, zero in the 38 Claude captures. Every other box omp draws closes
// corner-to-corner (`╰────╯`). And omp paints its pickers at the composer's own 189 cells, so width
// could not have separated them even in principle — the corpus measures 189/189 on all 10 composer
// captures too, i.e. the exact check was never observed failing OR discriminating. What pins the shape
// is the literal, the contiguous `│  …  │` run above it, the `╭─…─╮` directly above that run, the tail
// anchor, and the two caps — every one of them a claim about glyphs both renderers agree on.

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
}

/**
 * Locate omp's composer box at the tail of `lines`, or null. Bottom-up, four steps, each of which can
 * only ever REJECT — there is no branch that widens the claim.
 *
 *     ╭── <statusline> ───╮      (c) top border, DIRECTLY above the run (b) pinned
 *     │  <draft row…>     │      (b) 0..MAX_DRAFT_ROWS contiguous gutter rows
 *     ╰─ <draft tail> ────╯      (a) the bottom border — the anchor everything else hangs off
 *     ❯ <palette row…>           (a) 0..MAX_SUGGESTION_ROWS non-blank, non-BOX rows, up to the tail
 *
 * OMP 18.1.2 also emits a clipped two-row form: an arbitrary status row directly above an
 * open-ended `╰─ <draft>` prompt. The prompt's missing right chrome is its anchor; other boxes close
 * corner-to-corner, so they cannot enter that branch.
 * Every gate is a glyph predicate or an adjacency; none is a measurement. See the block above for why
 * the width equalities that used to co-sign (b) and (c) are gone and must stay gone.
 */
export function locateComposer(lines: StyledLine[]): ComposerBox | null {
  const texts = lines.map((l) => rstrip(lineText(l)));
  let end = texts.length - 1;
  while (end >= 0 && isBlank(texts[end]!)) end--;
  if (end < 0) return null;

  // (a) The bottom border, and the autocomplete run (if any) omp painted below it. Nothing here reads
  //     a palette row's CONTENT, because those rows are model- and user-authored text (they carry
  //     `skill:…` entries assembled from the user's own machine); the run is bounded by having to be
  //     CONTIGUOUS non-blank rows running to the tail, none of them a box, plus the cap.
  //
  //     THE BOX RULE IS THE TAIL ANCHOR, and it is the load-bearing half of this step. Without it the
  //     claim being made is only "a composer bottom border exists somewhere in the last 64 rows",
  //     which is not the claim `composerReady` needs: what it must answer is whether the composer has
  //     the KEYBOARD, and a modal that took it is drawn IN FRONT of the composer, i.e. below it in the
  //     buffer. omp draws every one of those — the six pickers, the five Ask screens, the welcome
  //     panel, the tool-result box, the `╭─── ✘ Error: … ───╮` banner — as a box starting at column 0,
  //     so `opensBox` on the run says "something else owns this screen" without having to recognise
  //     any of them individually (omp's tool-approval dialog is not in the corpus; it is a box too if
  //     it is drawn like the eleven that are — see index.ts, which is honest that this is inferred).
  //     Before this rule, a single blank row was the entire difference between the two verdicts: with
  //     omp's usual blank separator above a dialog the walk stopped and the answer was null, and
  //     without it the dialog's own rows passed as "palette" and the pre-flight armed the composer's
  //     destructive pre-clear sweep against a live modal. That blank is a row omp happens to paint,
  //     not a claim anything checked.
  //
  //     Each row used to have to measure the box's own width too. On a capture — where every row is
  //     padded out with spaces — that is the claim "this row reaches the terminal's right edge", which
  //     holds of the palette only because omp happens to paint a scrollbar column at its edge (8 rows
  //     across 2 captures), and fails outright the moment a `skill:` description carries a glyph our
  //     table and omp's disagree about. Both of those are FALSE NULLS, i.e. the permanent block. What
  //     the check bought was narrower: on a torn frame (a composer scrolled up with real transcript
  //     beneath it — a shape no capture in this corpus shows) the strip now takes up to
  //     MAX_SUGGESTION_ROWS of that transcript off the mirror along with the box. That residue is
  //     cosmetic and bounded, and — now that the box rule above rejects the run outright when a widget
  //     is drawn into it — the rows it can still swallow are plain transcript, never a modal the user
  //     needs to see. A width equality would not have bought any of this back: omp paints its pickers
  //     at the composer's own 189 cells, so it could never have told the two apart.
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
      // A blank row means the box is not what this run hangs off — omp pads every row of its own
      // chrome to the full terminal width, so a blank INSIDE the run is a shape it cannot draw.
      if (isBlank(texts[row]!)) return null;
      // A box row means something is drawn IN FRONT of the composer, so the composer does not have
      // the keyboard even though its border is on screen. Decline the whole shape rather than treat
      // that box as autocomplete: `hasComposer` false is the fail-closed answer the contract asks
      // for, and it also keeps the modal on the raw mirror where the user can actually see it.
      if (opensBox(texts[row]!)) return null;
    }
  }
  const suggestEnd = end + 1;
  const openBottom = isOpenComposerBottom(texts[bottom]!);

  // (b) Continuation rows of a wrapped draft, walking up from the bottom border. The two-space gutter
  //     is the whole predicate, and it is not asked to carry the claim alone: the walk starts on a row
  //     already established as the composer's bottom border, is capped, and terminates on a row step
  //     (c) has to accept. A gutter row that stops the walk early would strand `i` mid-box and fail
  //     (c) on a composer that is plainly there, so nothing here may depend on the row's CONTENT —
  //     which is the user's own draft text, emoji and all.
  let i = bottom - 1;
  while (i >= 0 && bottom - i <= MAX_DRAFT_ROWS && composerContText(texts[i]!) !== null) {
    i--;
  }

  // OMP 18.1.2's clipped shape has no `╭…╮` top border. Its open-ended `╰─ <draft>` row is the
  // discriminator, and the non-blank row directly above the continuation run is the standalone
  // statusline to re-surface. A miss here stays fail-closed for destructive pre-type work.
  if (openBottom) {
    if (i < 0 || isBlank(texts[i]!)) return null;
    return { top: i, firstDraftRow: i + 1, bottom, suggestEnd };
  }

  // (c) The top border — the LAST anchor checked, which is what pays for `isComposerTop` being loose
  //     (see markers.ts). By now the bottom border, the continuation walk and the cap have pinned the
  //     rest of the shape, and this row closes it by being a `╭─…─╮` DIRECTLY above the run they
  //     pinned. Its WIDTH is deliberately not checked: this is the row omp paints the user's
  //     configurable statusline into, so any equality here is a demand that our table agree with their
  //     terminal on their template. A `╭─…─╮` of a different width sitting immediately above a
  //     `╰─ … ─╯` is therefore accepted as the top border — the most a torn frame can cost is a wrong
  //     statusline row and a few extra rows trimmed off the mirror. No modal capture in the corpus can
  //     even reach this line: none of them draws a `╰─ … ─╯` for step (a) to anchor on, and step (a)
  //     now also refuses any shape with one of omp's boxes UNDER it. What this step does NOT prove is
  //     that the two-row shape belongs to the composer specifically — `╭─…─╮` is drawn by at least
  //     seven omp widgets, so the discrimination rests entirely on the bottom border's one-space
  //     gutter, which across all 59 captures occurs once per composer capture and nowhere else. That
  //     census is the evidence, and it is a claim about omp 17.2.12's renderer rather than a proof:
  //     a widget that ever writes a label INTO its bottom border the way the composer does would be
  //     indistinguishable here. index.ts records it as a known limit of the Tier-1 lift.
  if (i < 0 || !isComposerTop(texts[i]!)) return null;

  return { top: i, firstDraftRow: i + 1, bottom, suggestEnd };
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

  // 1. Drop a trailing run of blank lines. The empty buffer takes the SAME-REFERENCE exit the tail
  //    return below takes, and for the same reason: nothing was removed from `[]`, so a caller
  //    testing `result === lines` must see "no chrome" rather than a fresh array that says otherwise.
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return lines.length === 0 ? lines : lines.slice(0, 0);

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
 * Load-bearing beyond the preview: reply-action.ts runs omp panes through type-then-verify, and THIS
 * is the verify half — a wrong answer stalls every free-text send with "Message didn't reach the
 * input box". The bottom border's tail therefore has omp's INLINE SUGGESTION taken off it
 * (`composerGhost`, markers.ts): that ghost is not in the input buffer, so leaving it in made the
 * guard compare a screen the operator never typed against the message it had just sent, and every
 * send omp offered a completion for stalled.
 */
export function extractInputDraft(lines: StyledLine[]): string | null {
  const box = locateComposer(lines);
  if (box === null) return null;
  const texts = lines.map((l) => rstrip(lineText(l)));

  const parts: string[] = [];
  for (let i = box.firstDraftRow; i < box.bottom; i++) {
    parts.push(composerContText(texts[i]!)!.trim());
  }
  const tail = rstrip(composerBottomText(texts[box.bottom]!)!);
  const ghost = composerGhost(lines[box.bottom]!);
  const typed = ghost.length > 0 && tail.endsWith(ghost) ? tail.slice(0, -ghost.length) : tail;
  parts.push(typed.trim());

  const draft = parts.filter((p) => p.length > 0).join(" ");
  return draft.length === 0 ? null : draft;
}

/**
 * Whether omp's free-text composer is on screen at the tail — i.e. whether typing a reply would land
 * in the input box at all, rather than in a modal that has the keyboard.
 *
 * This is the highest-leverage function in the adapter. A definite `false` makes the reply pre-flight
 * refuse before a byte is typed; a `true` also authorises the prompt-bound pre-clear sweep. Both the
 * closed OMP 17 box and OMP 18.1.2's open-ended prompt row are therefore parsed above before this
 * function answers.
 *
 * "On screen at the tail" is meant strictly, and step (a)'s box rule is what makes it true: a composer
 * border with one of omp's boxes painted UNDER it answers `false`, because whatever that box is has
 * the keyboard. Without that rule this would only have said "a composer border exists somewhere in
 * the last 64 rows", which a dialog stacked straight onto the composer satisfies.
 */
export function hasComposer(lines: StyledLine[]): boolean {
  return locateComposer(lines) !== null;
}

/** `DEFAULT_PROMPT_TAIL_LINES` in bridge/prompt-binding.ts — mirrored, the way web mirrors wire types. */
const BRIDGE_PROMPT_TAIL_LINES = 6;

/**
 * The composer's OWN prompt row, verbatim as it sits on screen (trailing padding dropped), or null
 * when there is no composer at the tail. This is the `expected_prompt` the reply path binds its
 * destructive pre-clear sweep to: the bridge re-reads the pane and 409s the write when this exact line
 * is no longer near the tail, so the burst cannot land on a screen that moved between the pre-flight's
 * read and the keys (lib/reply-action.ts; bridge/server.ts `checkPromptBinding`).
 *
 * The `╰─ … ─╯` row is the right region for that job twice over. It is the most distinctive line omp
 * draws — the census behind `composerBottomText` is that it appears once per composer capture and
 * nowhere else in 58 — and it is literally the line the sweep is about to erase, carrying the tail of
 * the very draft those Backspaces are counted against. So a binding failure is not a proxy for
 * "something changed"; it is exactly "the line I am about to clear is not the line I read".
 *
 * Text, not a model: the bridge compares normalized plain rows, and anything cleverer here would be a
 * claim about content this adapter deliberately does not read.
 */
export function composerPrompt(lines: StyledLine[]): string | null {
  const box = locateComposer(lines);
  if (box === null) return null;

  // Decline the binding when omp has painted too much below the box for the bridge to accept it.
  // `verifyExpectedPrompt` (bridge/prompt-binding.ts) matches the region against the fresh read's
  // NON-BLANK rows and requires the match to end inside the last DEFAULT_PROMPT_TAIL_LINES (6) of
  // them — so a one-row region needs at most 5 non-blank rows beneath it. Every row in
  // `(bottom, suggestEnd)` is non-blank by construction (locateComposer step (a) rejects a blank
  // inside the run) and everything past `suggestEnd` is trailing blanks the bridge's normalization
  // drops, so that count is exactly `suggestEnd - bottom - 1`. The slash palette lives down there
  // and MAX_SUGGESTION_ROWS admits 64 rows of it, so a long enough palette would put the composer's
  // own row out of reach and 409 EVERY destructive sweep with "The input box changed while clearing
  // it" — a permanent, unexplainable refusal on a screen where nothing is wrong. Null instead means
  // an unbound write, which is exactly what this adapter did before it named a region at all: the
  // sweep loses its binding, never its pre-flight.
  if (box.suggestEnd - box.bottom - 1 > BRIDGE_PROMPT_TAIL_LINES - 1) return null;

  const row = rstrip(lineText(lines[box.bottom]!));
  return row.length === 0 ? null : row;
}
