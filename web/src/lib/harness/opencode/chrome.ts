// The opencode composer scanner — locates the composer TAIL at the buffer's end, strips exactly the
// composer's own chrome off the mirror (the draft rows, the model row, the rule and the status rows
// below it), and re-surfaces the three things the strip would otherwise destroy: the statusline, a
// stranded draft, and — the reason this layer exists at all — `composerReady`.
//
// A ┃ row is NOT "the composer" the way omp's box is: the transcript's messages and tool runs draw
// the same bar above it. So the scanner is deliberately a TAIL scanner — it claims only
// [draft block … status rows] and leaves every row above (the run's live content and the
// transcript) on the mirror. Its structure, bottom-up:
//
//     [ … transcript … ]                      <- kept, always; its last block ends on a row with no bar
//     ┃                                        <- the composer's top padding
//     ┃  <the draft, wrapped>                  } the draft block: the composer's bar run between its
//     ┃                                        }   top padding and the separator above the model row
//     ┃  Build · GPT-6 Astra Pro OpenRouter …  <- the model row: the last TEXT row inside the bar
//     ┃                                        <- a bare bar row, at 50 columns only (see (b))
//     ╹▀▀▀▀▀▀▀▀▀▀▀▀                            <- the bottom rule
//     <cwd> … ctrl+p commands                  <- status rows (chrome; re-surfaced by the probe)
//
// Every gate is a glyph predicate or an adjacency, and no predicate reads a row's CONTENT except where
// the contract names it (the draft gutter, the placeholder prefix, the dialog footer's own hints, a
// picker's `esc` and `Search`). Only the picker check measures anything: it compares two columns.
// Pure; no pane access, no network.

import type { StyledLine } from "../../blocks";
import {
  barDraftText,
  hasFooterHints,
  isBareBar,
  isBarRow,
  isBlank,
  isModelRow,
  isOverlayRow,
  isQuestionFooter,
  isRuleRow,
  lineText,
  OVERLAY_CHROME_GLYPHS,
  rstrip,
} from "./markers";
import { displayWidth } from "../../text-width";

// How much composer a torn or scrolled frame may claim. The tail walk is bounded so a foreign or
// torn buffer can't reach an arbitrarily distant rule. The tallest composer run observed in the
// corpus is 8 interior rows (the fresh-idle splash padding) plus a working run's tool rows — the
// working state's interior grows with the run, so the cap is generous on purpose: too low returns
// null on a perfectly ordinary working screen (every reply refused, the composer duplicated on the
// mirror), while too high only bounds how much TORN TRANSCRIPT the strip can eat, which is the
// cosmetic cost it governs.
const MAX_INTERIOR_ROWS = 100;

// The status rows painted BELOW the rule: the key-hint row, a rotating `● Tip …` on a fresh session,
// the cwd/version row. At 50 columns the tip wraps (two rows measured on 1.18.32, and a longer tip
// takes three) and the cwd/tokens row folds onto a second row, so the bound leaves room for that.
// Bounded — a run longer than this under the rule is not a composer tail.
const MAX_STATUS_ROWS = 6;

// Bare bar rows between the model row and the rule. None at full width; opencode 1.18.32 paints one
// at 50 columns (measured 2026-09-26, `oc--narrow--fresh-idle.txt`). Two leaves a row of slack;
// more than that is not the composer's bottom.
const MAX_RULE_PAD = 2;

// A foreign panel's box border where it crosses the composer's bar run. TWO conditions, and it takes
// both, because either one alone gets a real draft wrong:
//
//   the ANCHOR — a corner or a junction. A plain rule (────) is not one, because people type those:
//   oc--draft-multiline.txt has a row that is nothing but a rule INSIDE a real draft, and the run has
//   to read through it.
//
//   and NOTHING BUT CHROME on the row. A junction ANYWHERE was the first shape of this rule, and it
//   truncated a draft: `├── src` carries a junction and words, a pasted `tree` is the ordinary way
//   that happens, and the walk stopped at the first branch. Measured on
//   oc--draft-tree-glyphs.txt — four typed lines read back as the last one.
//
// A panel's border is never words. That is the whole distinction, and it is the same one
// {@link isPanelBorder}'s use in `extractInputDraft` rests on, so the two cannot drift.
const PANEL_JUNCTION = /[┌┐└┘├┤┬┴┼╭╮╰╯╔╗╚╝╠╣╦╩╬]/u;
const CHROME_ONLY = /^[\s─━┄┈│┃═║┌┐└┘├┤┬┴┼╭╮╰╯╔╗╚╝╠╣╦╩╬╹▀]*$/u;

/**
 * True when this row's interior is a foreign panel's border and nothing else.
 *
 * The INTERIOR, not the whole row: the composer's own `┃` is chrome by definition and says nothing
 * about what was typed inside it.
 */
function isPanelBorder(text: string): boolean {
  const inside = interiorOf(text);
  return PANEL_JUNCTION.test(inside) && CHROME_ONLY.test(inside);
}

// A sidebar's vertical edge where it crosses the bar run: `│` and nothing else. It is
// padding, not content — the trims below and the empty filter treat it the way they treat
// a bare bar row. Deliberately NOT part of isPanelBorder: that predicate answers "border"
// for the walk and the join together, and an edge-only row must stay walkable so typed
// words below it still read (same reason the walk reads through a typed rule).
function isBlankInterior(text: string): boolean {
  return isEdgeOnly(interiorOf(text));
}

function isEdgeOnly(text: string): boolean {
  return /^[\s│]*$/u.test(text);
}

// A panel's bottom border sharing its row with typed text (`┃  hello  └───┘`): cut the
// trailing border run, keeping the words. The run must hold a corner or junction: `│`, `┃`
// and rule-blocks alone never strip, because a table row (`│ a │ b │`) ends in one and
// cutting it breaks the reply guard's contiguity check — the stripped run is gone from the
// draft but still in what was sent, so verification can never match. A typed rule (`───`)
// never strips for the same reason. The strip applies only when words remain; a border-only
// row keeps its text for the isPanelBorder join below to refuse. The run must also follow a gap of
// two or more spaces: an overlay sits in its own column, far from the typed words, while a pasted
// `╭─ title ─╮` or `┌ Name ┐` closes its box one space after its words and must stay whole. The walk still owns
// row-level stops — this owns suffixes in kept rows.
const OVERLAY_SUFFIX =
  /[ \t]{2,}[─━┄┈│┃═║┌┐└┘├┤┬┴┼╭╮╰╯╔╗╚╝╠╣╦╩╬╹▀]*[┌┐└┘├┤┬┴┼╭╮╰╯╔╗╚╝╠╣╦╩╬][─━┄┈│┃═║┌┐└┘├┤┬┴┼╭╮╰╯╔╗╚╝╠╣╦╩╬╹▀]*$/u;

function stripOverlaySuffix(text: string): string {
  const cut = text.replace(OVERLAY_SUFFIX, "");
  return cut.trim() === "" ? text : cut;
}

/** The composer tail located at the buffer's end. Every index is into the ORIGINAL `lines` array. */
export interface ComposerTail {
  /** The FIRST row of the draft block — equal to `modelRow` when there is no draft (the strip then
   *  starts at the model row). The placeholder row counts as the draft block for the strip. */
  draftStart: number;
  /** The draft block's last row (`modelRow - 1` when there is no draft). The separator row between
   *  the draft and the model row is part of the strip, not of the draft. */
  draftEnd: number;
  /** The model row — the last text row inside the bar, above the rule (and above the bare bar row
   *  a 50-column pane paints between them). */
  modelRow: number;
  /** The ╹▀▀ rule row. */
  rule: number;
  /** EXCLUSIVE end of the status run below the rule (`rule + 1` when there is none). */
  statusEnd: number;
}

/** The draft text an interior row carries inside its bar, trimmed — what "blank" means inside the
 *  run: a bare-bar row (the bar alone, no gutter text) carries nothing. */
function interiorOf(text: string): string {
  return barDraftText(text)?.trim() ?? "";
}

/**
 * Locate the composer tail at the end of `lines`, or null. Bottom-up, each step able only to REJECT:
 *
 *     <status rows>              (a) 0..MAX_STATUS_ROWS non-bar rows running to the tail
 *     ╹▀▀▀▀▀▀▀▀                  (a) the rule — the anchor everything else hangs off
 *     ┃                          (b) 0..MAX_RULE_PAD bare bar rows (one at 50 columns)
 *     ┃  Build · GPT-6 …         (b) the model row, directly above those, shape-checked
 *     ┃                          (c) one bare bar row, the separator (absent = no draft)
 *     ┃  <the draft…>            (d) the bar run above it, to the top padding (blank lines inside)
 *     ┃                          (d) the top padding: the run's first row
 */
export function locateComposer(lines: StyledLine[]): ComposerTail | null {
  const texts = lines.map((l) => rstrip(lineText(l)));

  // (a) The rule, and the status run painted below it. The status area is PADDED: opencode paints
  //     the status row directly under the rule and the version row at the very bottom of the pane,
  //     with blank rows between them (measured on the idle capture) — so the walk skips blanks and
  //     bounds the run by its NON-BLANK rows. A bar row under the rule is the shape of a dialog
  //     footer (a modal owns the screen): decline instead of claiming a composer that cannot be
  //     typed into.
  let rule = -1;
  let statusRows = 0;
  for (let k = texts.length - 1; k >= 0; k--) {
    if (isBlank(texts[k]!)) continue;
    if (isRuleRow(texts[k]!)) {
      rule = k;
      break;
    }
    if (isBarRow(texts[k]!)) return null; // the tail is a modal's row, not composer chrome
    statusRows++;
    if (statusRows > MAX_STATUS_ROWS) return null;
  }
  if (rule < 0) return null;
  const statusEnd = lines.length;

  // (b) The model row: the last text row inside the bar, shape-checked. It is the row opencode
  //     always paints last inside the box, whatever the run above is doing. At full width it sits
  //     directly on the rule; at 50 columns 1.18.32 leaves one bare bar row between them, and
  //     reading only the row on the rule refused every reply on a healthy narrow pane. Bare bar
  //     rows are stepped over, bounded, and nothing else is: a text row there must BE the model row.
  let modelRow = rule - 1;
  while (modelRow >= 0 && rule - modelRow <= MAX_RULE_PAD && isBareBar(texts[modelRow]!)) modelRow--;
  if (modelRow < 0 || !isBarRow(texts[modelRow]!) || !isModelRow(texts[modelRow]!)) return null;

  // (c) One bare bar row above the model row: the separator under the draft. No separator ⇒ no
  //     draft; the strip then starts at the model row and the draft probe answers null.
  // (d) The draft: the composer's own bar run above the separator, up to its top padding row. The
  //     run ends where the bars do: the transcript's last block sits across a row with no bar (its
  //     bottom margin, measured on every 1.18.32 capture) — and, since the Models-sidebar overlay,
  //     at a row that is a foreign box border and nothing else (isPanelBorder): claiming that row
  //     joined overlay chrome into the draft, which broke the reply guard's verification of real
  //     messages. "And nothing else" is load-bearing, not caution: a row holding a junction AND words
  //     is a pasted tree, and stopping there loses most of a real draft. Inside
  //     the run, a bare bar row is a blank line the operator typed, not the draft's edge
  //     (oc--draft-multiline.txt): stopping there read only the last paragraph, left the first on
  //     the mirror as if it were transcript, and "Take over" copied half a draft. Bare-bar rows at
  //     either end (the top padding, the empty row of an empty composer) are not draft.
  let draftStart = modelRow;
  let draftEnd = modelRow - 1;
  const above = modelRow - 1;
  if (above >= 0 && isBareBar(texts[above]!)) {
    let top = above;
    while (
      top - 1 >= 0 &&
      modelRow - (top - 1) <= MAX_INTERIOR_ROWS &&
      isBarRow(texts[top - 1]!) &&
      !isPanelBorder(texts[top - 1]!)
    )
      top--;
    let first = top;
    let last = above - 1;
    while (first <= last && isBlankInterior(texts[first]!)) first++;
    while (last >= first && isBlankInterior(texts[last]!)) last--;
    if (first <= last) {
      draftStart = first;
      draftEnd = last;
    }
  }

  return { draftStart, draftEnd, modelRow, rule, statusEnd };
}

/**
 * Return `lines` with the composer's own chrome cut off the tail: the draft block (the placeholder
 * counts as one), the blank under it, the model row, the rule, and the status rows below. Rows above
 * — the agent's live run, the transcript — are kept. When nothing matches, the input is returned
 * AS-IS (same reference), so callers can treat an unchanged result as "no chrome".
 *
 * After the cut the trailing run is trimmed of blank rows AND bare-bar rows — the box's own interior
 * padding above the draft would otherwise remain as a hanging bar row. The trim never reaches
 * content: a row with anything but a bar (or blank) on it stops it.
 */
export function stripChrome(lines: StyledLine[]): StyledLine[] {
  const tail = locateComposer(lines);
  if (tail === null) {
    // No composer tail: only the trailing blank run may go, unchanged-otherwise.
    const texts = lines.map((l) => rstrip(lineText(l)));
    let end = lines.length;
    while (end > 0 && isBlank(texts[end - 1]!)) end--;
    return end === lines.length ? lines : lines.slice(0, end);
  }
  let end = tail.draftStart; // everything from the draft (or the model row) down is chrome
  const texts = lines.map((l) => rstrip(lineText(l)));
  while (end > 0 && (isBlank(texts[end - 1]!) || isBareBar(texts[end - 1]!))) end--;
  return end === lines.length ? lines : lines.slice(0, end);
}

/**
 * The status rows painted BELOW the rule, verbatim and STYLED — cwd, key hints, the token/cost run,
 * the version row. `[]` when there is no composer tail (a dialog owns the screen, or the buffer is
 * foreign/torn): nothing to surface. Rows stay STYLED because opencode colours the key hints and the
 * cwd separately; flattening would lose what makes the strip readable at a glance.
 */
export function extractStatusLines(lines: StyledLine[]): StyledLine[] {
  const tail = locateComposer(lines);
  if (tail === null) return [];
  // Only the rows that carry something: the padded blank rows between the rule and the version row
  // are layout, not chrome worth re-surfacing.
  return lines.slice(tail.rule + 1, tail.statusEnd).filter((l) => !isBlank(rstrip(lineText(l))));
}

/**
 * The user's draft stranded on the interior rows, or null.
 *
 * The draft block is the composer's own bar run between its top padding and the separator above
 * the model row (`locateComposer` (d)) — its position holds whether or not the agent is working,
 * because a running tool paints in the transcript, across a row with no bar.
 *
 * Wrapped rows fold with a single space: opencode word-wraps at a break it removed. A blank line
 * inside the draft is dropped from the text; the reply guard's check treats a fold's gap as
 * unknowable width anyway (`draftCarriesSend`). The placeholder row reads as no draft. `null` also
 * covers "no composer tail".
 */
export function extractInputDraft(lines: StyledLine[]): string | null {
  const tail = locateComposer(lines);
  if (tail === null) return null;
  const texts = lines.map((l) => rstrip(lineText(l)));
  if (tail.draftStart > tail.draftEnd) return null; // no draft block — only the model row below
  const parts: string[] = [];
  for (let i = tail.draftStart; i <= tail.draftEnd; i++) {
    // A bare bar row inside the block is a blank line of the draft. A sidebar row sharing
    // the bar run reads as blank too — but only with panel box glyphs aboard: the width
    // gate alone would also eat deeply-indented typed code, which has no box glyphs.
    if (isOverlayRow(texts[i]!) && OVERLAY_CHROME_GLYPHS.test(texts[i]!)) {
      parts.push("");
      continue;
    }
    const text = isBareBar(texts[i]!) ? "" : barDraftText(texts[i]!);
    if (text === null) return null; // a non-gutter row inside the block — not a shape we claim
    const cleaned = stripOverlaySuffix(text);
    const trimmed = cleaned.trim();
    // A palette-box blank row (`┃` + pad + `┃`) carries no words — only the composer's own
    // bar plus a panel's right edge — so it reads as blank, never as a one-glyph draft line
    // that would poison the join ("┃ …") and stall verification. Scoped to blank rows in
    // this reader on purpose: the walk-stop (isPanelBorder) and the dialog walks must keep
    // seeing the row, and a trailing `┃` on a row WITH words stays untouched (tables).
    parts.push(isEdgeOnly(trimmed) || /^[\s┃]*$/.test(trimmed) ? "" : trimmed);
  }
  const draft = parts.filter((p) => p.length > 0).join(" ");
  if (draft.length === 0) return null;
  if (draft.trimStart().startsWith("Ask anything")) return null; // the empty box's placeholder
  // The walk above cannot always exclude a panel's border — it can land on the separator row, which
  // the walk never climbs past — so a border-only join surfaced as a phantom "Draft in terminal"
  // card holding just a line, and "Take over" would have typed border junk into the composer.
  //
  // ONE predicate with the walk, deliberately: a first cut of this rule used a second, WIDER glyph
  // set here, which said `─` and `│` were border glyphs while the walk's own comment said they were
  // not. Two sets that disagree about the same question are two answers waiting to drift. So a join
  // is refused on exactly the terms a row is: a junction, and no words. A draft of nothing but a
  // typed rule is therefore a draft, which is what the operator typed.
  if (isPanelBorder(`┃ ${draft}`)) return null;
  return draft;
}

/**
 * Whether opencode's free-text composer is on screen and holds the keyboard — the reply pre-flight's
 * gate. `false` must be DEFINITE on every screen where typing would not reach the composer: a
 * permission dialog painted inside the bar run (its footer is a bar row, so the tail walk never
 * reaches the rule), a picker floating over the screen, and a foreign/torn buffer.
 *
 * A picker paints OVER the middle of the screen and can leave the composer's own tail intact — so
 * the tail shape alone would answer `true` on a screen whose keyboard the picker owns.
 * `pickerOverlayUp` is the predicate that says so.
 */
export function hasComposer(lines: StyledLine[]): boolean {
  if (locateComposer(lines) === null) return false;
  return !pickerOverlayUp(lines);
}

/** A row cut into its 2+-space-separated tokens, each with the display column it starts at. */
function columnTokens(text: string): { text: string; col: number }[] {
  const out: { text: string; col: number }[] = [];
  const token = /\S+(?: \S+)*/g;
  let m: RegExpExecArray | null;
  while ((m = token.exec(text)) !== null) out.push({ text: m[0], col: displayWidth(text.slice(0, m.index)) });
  return out;
}

/** How far below the title row the search field may sit. Two on every picker measured (a blank row
 *  between them); one leaves room for a denser layout. */
const MAX_TITLE_TO_SEARCH = 2;

/**
 * Whether one of opencode's pickers is up: the ctrl+p command palette, `/agents`, `/models` and the
 * rest. They share one frame, measured on 1.18.32 (2026-09-26) and in the contributor's palette
 * capture: a TITLE row whose title is followed by the `esc` dismiss hint (`Select agent … esc`,
 * `Commands … esc`), and one or two rows under it the search field, a `Search` row whose word starts
 * in the title's own column. The shape is shared; the titles are not, so no title is named here.
 *
 * Keyed on columns rather than on whole rows because a picker paints only its own box: the screen
 * under it shows through on both sides. A transcript row can sit at its left (`┃  create a file…`)
 * and, when it is long, at its right, and the row between the title and the search field can carry
 * transcript text too. The whole buffer is scanned, because a picker sits in the middle of a tall
 * pane, far from the tail.
 *
 * Known gap: once the operator types a filter, the field shows the filter instead of `Search`, and
 * this answers false (`oc--command-palette-query.txt`, pinned as `it.fails` in opencode.test.ts). A
 * reply typed then lands in the filter; the submit key stays withheld, because the reply guard never
 * sees the words in the composer.
 */
export function pickerOverlayUp(lines: StyledLine[]): boolean {
  const rows = lines.map((l) => columnTokens(rstrip(lineText(l))));
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    for (let k = 0; k + 1 < row.length; k++) {
      if (row[k + 1]!.text !== "esc" || row[k]!.text === "esc") continue;
      const col = row[k]!.col;
      for (let j = i + 1; j < rows.length && j - i <= MAX_TITLE_TO_SEARCH; j++) {
        if (rows[j]!.some((t) => t.text === "Search" && t.col === col)) return true;
      }
    }
  }
  return false;
}

/** How many non-blank rows from the tail a dialog footer may sit: the permission steps paint one
 *  bare bar row under it. The same window the dialog lift allows (dialog.ts). */
const MODAL_FOOTER_WINDOW = 3;

/**
 * Positive evidence that one of opencode's own modals is up — the fifth condition of the
 * unread-dialog card (.adr/0053, addendum 2026-09-26). `composerReady` answering false says only
 * that no composer is there, which is also what the shell looks like while opencode starts and
 * after it exits; the card must not offer Escape there. Three shapes count: a picker
 * (`pickerOverlayUp`), a permission dialog painted in the bar run, whose footer — a bar row
 * carrying `⇆ select` and `enter confirm` — sits at the tail (1.18.32), and a question dialog,
 * whose footer is a bar row carrying `esc dismiss` after `enter submit|toggle|confirm` (1.18.33).
 * The question footer counts on EVERY question screen, the ones the grammar refuses included (a tab
 * bar, a long list): the card and the composer lock must work on exactly those.
 */
export function modalOnScreen(lines: StyledLine[]): boolean {
  if (pickerOverlayUp(lines)) return true;
  let seen = 0;
  for (let i = lines.length - 1; i >= 0 && seen < MODAL_FOOTER_WINDOW; i--) {
    const text = rstrip(lineText(lines[i]!));
    if (isBlank(text)) continue;
    seen++;
    if (isBarRow(text) && (hasFooterHints(text) || isQuestionFooter(text))) return true;
  }
  return false;
}

/**
 * Whether a full overlay box holds the keyboard: a bar row the heavy ┃ opens AND closes (the
 * /models-style overlay paints its own bordered box over the middle of the screen, filter row
 * included). Transcript, composer, description and footer rows never close with ┃, and
 * agent-authored │ tables cannot match either — only the overlay box borders in heavy ┃ on both
 * sides. Bare bar rows (padding) are excluded.
 *
 * Deliberately NOT folded into `pickerOverlayUp`/`modalOnScreen`: those feed the unread-dialog
 * card, the composer gate and the conformance leg, where a new shape would move existing
 * verdicts. The reply path consults this separately (`lib/reply-action.ts`), so a miss here only
 * ever refuses a send, never a card. Measured on 1.18.32 (`oc--slash-palette.txt`,
 * `oc--command-palette-query.txt`); every non-box capture must stay false (the suites pin it).
 * User-typed text ending in a heavy ┃ would match too — accepted, essentially untypable, and a
 * hit only ever refuses.
 */
export function overlayHoldsKeyboard(lines: StyledLine[]): boolean {
  return lines.some((l) => {
    const text = rstrip(lineText(l));
    if (!isBarRow(text) || !text.endsWith("┃")) return false;
    return text.replace(/^\s*┃/, "").slice(0, -1).trim().length > 0;
  });
}

/** The model row down to the rule, verbatim as they sit on screen (trailing padding dropped) — the
 *  region the reply path binds its DESTRUCTIVE pre-clear sweep to. It is the right region for that
 *  job because the sweep (`ctrl+k` + Backspaces) erases the draft ABOVE it without moving it: the
 *  rows are stable across the very keystrokes the binding protects. It ENDS at the rule rather
 *  than at the model row because the bridge accepts a binding only when it ends within the last 6
 *  non-blank rows: at 50 columns a fresh session paints the bare bar row, the rule, the key-hint
 *  row, a tip wrapped over two rows and the cwd row, which leaves the model row seventh from the
 *  bottom and the rule fifth. Null when there is no composer tail — the same screens
 *  `composerReady` refuses. */
export function composerPrompt(lines: StyledLine[]): string | null {
  const tail = locateComposer(lines);
  // The same screens `composerReady` refuses bind nothing: a sweep never runs there, and naming a
  // region would hand the conformance leg a binding the pre-flight will not type into.
  if (tail === null || pickerOverlayUp(lines)) return null;
  const rows = lines.slice(tail.modelRow, tail.rule + 1).map((l) => rstrip(lineText(l)));
  return rows[0]!.length === 0 ? null : rows.join("\n");
}

/** Whether the draft text carried by the interior rows is opencode's own opaque token rather than
 *  the user's text. opencode shows no paste chip in any captured state — the draft is always the
 *  user's words — so nothing is opaque. If a large paste ever collapses to a token, capture it and
 *  teach this predicate rather than guessing. */
export function draftIsOpaque(_draft: string): boolean {
  return false;
}
