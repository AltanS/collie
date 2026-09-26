// The opencode composer scanner — locates the composer TAIL at the buffer's end, strips exactly the
// composer's own chrome off the mirror (the draft rows, the model row, the rule and the status rows
// below it), and re-surfaces the three things the strip would otherwise destroy: the statusline, a
// stranded draft, and — the reason this layer exists at all — `composerReady`.
//
// The bar run is NOT "the composer" the way omp's box is: the agent's live run (tool output rows, a
// spinner row, hint rows without the bar) paints INSIDE the same run of ┃ rows, above the draft. So
// the scanner is deliberately a TAIL scanner — it claims only [draft block … status rows] and
// leaves every row above (the run's live content and the transcript) on the mirror. Its structure,
// bottom-up:
//
//     [ … transcript / interior content … ]   <- kept, always
//     ┃  <the draft, wrapped>                  } the draft block: the contiguous non-blank bar run
//     ┃                                        }   directly above (one blank) the model row
//     ┃  Build · GLM-5.3-Flash OpenCode Go …   <- the model row: the LAST interior row
//     ╹▀▀▀▀▀▀▀▀▀▀▀▀                            <- the bottom rule
//     <cwd> … ctrl+p commands                  <- status rows (chrome; re-surfaced by the probe)
//
// Every gate is a glyph predicate or an adjacency; nothing measures widths, and no predicate reads a
// row's CONTENT except where the contract names it (the draft gutter, the placeholder prefix, the
// dialog footer's own hints). Pure; no pane access, no network.

import type { StyledLine } from "../../blocks";
import {
  barDraftText,
  isBarRow,
  isBlank,
  isModelRow,
  isRuleRow,
  lineText,
  rstrip,
} from "./markers";

// How much composer a torn or scrolled frame may claim. The tail walk is bounded so a foreign or
// torn buffer can't reach an arbitrarily distant rule. The tallest composer run observed in the
// corpus is 8 interior rows (the fresh-idle splash padding) plus a working run's tool rows — the
// working state's interior grows with the run, so the cap is generous on purpose: too low returns
// null on a perfectly ordinary working screen (every reply refused, the composer duplicated on the
// mirror), while too high only bounds how much TORN TRANSCRIPT the strip can eat, which is the
// cosmetic cost it governs.
const MAX_INTERIOR_ROWS = 100;

// The status rows painted BELOW the rule: a cwd row, a combined esc-interrupt/tokens row, a version
// row. Bounded — a run longer than this under the rule is not a composer tail.
const MAX_STATUS_ROWS = 4;

/** The composer tail located at the buffer's end. Every index is into the ORIGINAL `lines` array. */
export interface ComposerTail {
  /** The FIRST row of the draft block — equal to `modelRow` when there is no draft (the strip then
   *  starts at the model row). The placeholder row counts as the draft block for the strip. */
  draftStart: number;
  /** The draft block's last row (exclusive bound is `modelRow`); equals `modelRow - 1` — the blank
   *  between the draft and the model row is part of the strip, not of the draft. */
  draftEnd: number;
  /** The model row — the last interior row, directly above the rule. */
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
 *     ┃  Build · GLM …           (b) the model row, DIRECTLY above the rule, shape-checked
 *     ┃                          (c) one blank interior row (absent = no draft below)
 *     ┃  <the draft…>            (d) 0..MAX_INTERIOR_ROWS contiguous non-blank bar rows
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

  // (b) The model row: the interior row directly above the rule, shape-checked. It is the row
  //     opencode always paints last inside the box, whatever the run above is doing.
  if (rule === 0) return null;
  const modelRow = rule - 1;
  if (!isBarRow(texts[modelRow]!) || !isModelRow(texts[modelRow]!)) return null;

  // (c) One blank interior row, then the draft run. The blank is the boundary between the draft and
  //     whatever else the box carries above it (a working run's tool rows sit across MORE blanks) —
  //     measured on every draft capture in the corpus. No blank ⇒ no draft; the strip then starts
  //     at the model row and the draft probe answers null. A bare-bar row (the bar alone, no
  //     gutter text) is interior padding: its interior is empty.
  let draftStart = modelRow;
  let draftEnd = modelRow - 1;
  const above = modelRow - 1;
  if (above >= 0 && isBarRow(texts[above]!) && interiorOf(texts[above]!) === "") {
    let i = above - 1;
    while (i >= 0 && modelRow - i <= MAX_INTERIOR_ROWS && isBarRow(texts[i]!) && interiorOf(texts[i]!) !== "") {
      i--;
    }
    if (i + 1 <= above - 1) {
      draftStart = i + 1;
      draftEnd = above - 1;
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

/** A row whose only glyph is the bar — interior padding, not content. */
function isBareBar(text: string): boolean {
  return /^\s*┃\s*$/.test(rstrip(text));
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
 * The draft block is the contiguous non-blank bar run directly above the one blank row under the
 * model row — its position holds whether or not the agent is working (the working state's tool rows
 * and spinner sit across MORE blanks, so a run above the FIRST blank is the draft, never a tool row;
 * the working capture with no draft answers null because that row is blank too).
 *
 * Wrapped rows fold with a single space: opencode word-wraps at a break it removed. The placeholder
 * row reads as no draft. `null` also covers "no composer tail".
 */
export function extractInputDraft(lines: StyledLine[]): string | null {
  const tail = locateComposer(lines);
  if (tail === null) return null;
  const texts = lines.map((l) => rstrip(lineText(l)));
  if (tail.draftStart > tail.draftEnd) return null; // no draft block — only the model row below
  const parts: string[] = [];
  for (let i = tail.draftStart; i <= tail.draftEnd; i++) {
    const text = barDraftText(texts[i]!);
    if (text === null) return null; // a non-gutter row inside the block — not a shape we claim
    parts.push(text.trim());
  }
  const draft = parts.filter((p) => p.length > 0).join(" ");
  if (draft.length === 0) return null;
  if (draft.trimStart().startsWith("Ask anything")) return null; // the empty box's placeholder
  return draft;
}

/**
 * Whether opencode's free-text composer is on screen and holds the keyboard — the reply pre-flight's
 * gate. `false` must be DEFINITE on every screen where typing would not reach the composer: a
 * permission dialog painted inside the bar run (its footer is a bar row, so the tail walk never
 * reaches the rule), the ctrl+p command palette floating over the box, and a foreign/torn buffer.
 *
 * The palette overlay paints OVER the middle of the box, leaving the composer's own tail intact — so
 * the tail shape alone would answer `true` on a screen whose keyboard the palette owns. Its header
 * stack ("Commands", "Search", "Suggested" as exact whole rows) is the predicate that says so;
 * requiring all three makes a false `true` implausible while ordinary transcript text (which could
 * carry one of the words) never trips it.
 */
export function hasComposer(lines: StyledLine[]): boolean {
  if (locateComposer(lines) === null) return false;
  return !paletteOverlayUp(lines);
}

/** The last N rows scanned for the overlay's header stack. */
const PALETTE_SCAN = 30;
function paletteOverlayUp(lines: StyledLine[]): boolean {
  const seen = { Commands: false, Search: false, Suggested: false };
  let found = 0;
  for (let i = Math.max(0, lines.length - PALETTE_SCAN); i < lines.length && found < 2; i++) {
    // The overlay paints INSIDE the box's column space — its rows can carry the composer's own
    // leading bar at the left edge (measured), so the bar comes off before the exact match.
    const text = rstrip(lineText(lines[i]!)).replace(/^\s*┃/, "").trim();
    // The header row carries the overlay's own "esc" dismiss hint on its right end — so "Commands"
    // is matched by its leading text, while the two list headers below it are exact whole rows.
    if (text.startsWith("Commands") && !seen.Commands) { seen.Commands = true; found++; }
    else if (text === "Search" && !seen.Search) { seen.Search = true; found++; }
    else if (text === "Suggested" && !seen.Suggested) { seen.Suggested = true; found++; }
  }
  return found >= 2;
}

/** The model row, verbatim as it sits on screen (trailing padding dropped) — the region the reply
 *  path binds its DESTRUCTIVE pre-clear sweep to. It is the right region for that job because the
 *  sweep (`ctrl+k` + Backspaces) erases the draft ABOVE it without moving it: the row is stable
 *  across the very keystrokes the binding protects, and it sits within the bridge's tail window
 *  (the rule + status rows below it are at most 3 non-blank rows). Null when there is no composer
 *  tail — the same screens `composerReady` refuses. */
export function composerPrompt(lines: StyledLine[]): string | null {
  const tail = locateComposer(lines);
  // The same screens `composerReady` refuses bind nothing: a sweep never runs there, and naming a
  // region would hand the conformance leg a binding the pre-flight will not type into.
  if (tail === null || paletteOverlayUp(lines)) return null;
  const row = rstrip(lineText(lines[tail.modelRow]!));
  return row.length === 0 ? null : row;
}

/** Whether the draft text carried by the interior rows is opencode's own opaque token rather than
 *  the user's text. opencode shows no paste chip in any captured state — the draft is always the
 *  user's words — so nothing is opaque. If a large paste ever collapses to a token, capture it and
 *  teach this predicate rather than guessing. */
export function draftIsOpaque(_draft: string): boolean {
  return false;
}
