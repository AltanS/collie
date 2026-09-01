// The SLASH-AUTOCOMPLETE grammar — Claude Code's command-completion popup, the run of rows it paints
// DIRECTLY BELOW the input box's bottom border while the draft is still a partial slash command.
//
// Why it needs a grammar of its own, rather than a bigger window in chrome.ts: `locateInputBox`
// admits at most MAX_STATUS_LINES non-blank rows under the bottom border, and this popup is as tall
// as the operator's command list. Measured live (Claude Code v2.1.257, 2026-09-01) with `/model`
// typed on a machine carrying many skills: 23 rows — 17 entries, six of whose descriptions wrapped
// onto a continuation row. The walk hit the cap, returned null, and the whole screen fell back to the
// raw mirror with `composerReady` false, so every send stalled. Raising the cap is the wrong fix and
// .adr/0004 says why: the row count is not what protects that walk (the blank line above a dialog's
// footer is), and a taller blind window admits MORE screens it should refuse. So the popup is matched
// POSITIVELY, by its own shape, and peeled before the walk starts.
//
// The shape, and nothing about colour:
//
//     <bottom border>                                     ← the run must sit directly under this
//     "  /model                    Set the AI model…"     ← ENTRY row
//     "  /claude-api               Reference for the…"    ← ENTRY row
//     "                            opening the target…"   ← CONTINUATION row (description column)
//     …
//                                                         ← the run ends at the last non-blank line
//
// SELECTION IS SGR-ONLY. The highlighted entry is painted in a different colour (SGR 38;2;… plus a
// bold run over the matched substring) and is otherwise byte-identical to its neighbours — there is
// no pointer glyph, no bracket, no indent change. So nothing here may key on colour: the parse this
// grammar runs over is line TEXT, and every row is tested by shape alone. Matching on colour would
// also break the moment a theme changes, which is the same mistake `extractStatusLines` avoids by
// matching the statusline by position.
//
// THE DESCRIPTION COLUMN IS DERIVED, NEVER ASSUMED. Claude lays the popup out against its widest
// entry name, so the column sits at 43 in the capture above and at 23 in
// `fixtures/panes/claude--send-inflight.txt`. The run's own entry rows fix it, and every continuation
// row must then land on it exactly — which is what stops an arbitrary indented line joining the run.
//
// Pure functions over parsed line text. No pane access, no React, no keys: an `autocomplete` block is
// presentational (see harness/autocomplete-model.ts).

import type { StyledLine } from "../../blocks";
import type { AutocompleteEntry, AutocompleteModel } from "../autocomplete-model";
import { isBlank, isBoxBorder, lineText } from "./markers";

// An ENTRY row: exactly two leading spaces, the completion name, a gap of at least two spaces, then
// the description. The name is a leading "/" plus the character set Claude's command ids actually use
// — letters, digits, `-`, `_`, and the `:` that namespaces a plugin command (`/typescript:fix-types`).
// It deliberately admits NO further "/", which is what keeps an ordinary path-carrying statusline row
// ("  /home/altan/project   main") out of the run.
const ENTRY_ROW = /^ {2}(\/[A-Za-z0-9][A-Za-z0-9:_-]*)( {2,})(\S.*)$/;

// The same row with no description at all — a bare completion. Accepted so a popup whose entries
// carry no blurb still matches; it contributes no description column.
const BARE_ENTRY_ROW = /^ {2}(\/[A-Za-z0-9][A-Za-z0-9:_-]*) *$/;

// A CONTINUATION row: whitespace, then text. Its indent is checked against the run's derived
// description column, so this pattern only has to say "indented, non-empty" — the column does the
// discriminating. The floor keeps the pattern itself from matching a one-space-indented prose line
// before the column check is even reached.
const CONTINUATION_ROW = /^( {4,})(\S.*)$/;

// How many rows the popup may occupy. Generous ON PURPOSE, and safe in a way MAX_STATUS_LINES is not:
// every row inside the run has to match one of the two shapes above AND land on the run's own
// description column, so length buys an attacker nothing — an over-long run of real popup rows is
// still a real popup. A tight cap here would simply re-create the bug this module exists to fix (23
// rows observed for `/model` alone, and the list grows with the operator's skills). The cap remains
// only so a pathological buffer can't be walked without bound.
const MAX_AUTOCOMPLETE_LINES = 60;

/** Where the popup sits, and what it listed. `start` is the index of its FIRST row — the line
 *  immediately below the input box's bottom border, and the exclusive end of everything above. */
export interface AutocompleteRun {
  start: number;
  entries: AutocompleteEntry[];
}

/**
 * Find the completion popup at the tail of `texts`, where `end` is exclusive and `end - 1` is the
 * last NON-BLANK line. Returns the run, or null.
 *
 * The three things that make a match:
 *   1. the run reaches the last non-blank line of the screen — while the popup is open Claude paints
 *      neither the statusline nor a key-hint footer under it, so anything below the run means this is
 *      not a popup;
 *   2. its first row is an ENTRY row and the line directly above that is an input-box border;
 *   3. every row is an entry or a continuation landing exactly on the description column the entry
 *      rows themselves define.
 *
 * Anything else returns null and the caller behaves exactly as it did before this module existed.
 */
export function findAutocompleteRun(texts: string[], end: number): AutocompleteRun | null {
  let i = end - 1;
  let rows = 0;
  while (i >= 0 && rows < MAX_AUTOCOMPLETE_LINES) {
    const t = texts[i]!;
    if (isBlank(t) || isBoxBorder(t)) break;
    if (!ENTRY_ROW.test(t) && !BARE_ENTRY_ROW.test(t) && !CONTINUATION_ROW.test(t)) break;
    rows++;
    i--;
  }
  if (rows === 0) return null;
  // The border is the anchor, exactly as it is for the statusline run: without it we are looking at
  // indented prose somewhere in the transcript, not at a popup under a box.
  if (i < 0 || !isBoxBorder(texts[i]!)) return null;

  const start = i + 1;
  const entries = readEntries(texts, start, end);
  return entries === null ? null : { start, entries };
}

/**
 * Read the run [start, end) top-down into entries, or null when it isn't one. Every entry row that
 * carries a description must agree on the description column, and every continuation row must land on
 * that same column and belong to an entry above it. A run whose first row is a continuation is
 * refused outright: the popup's first row under the border is always an entry.
 */
function readEntries(texts: string[], start: number, end: number): AutocompleteEntry[] | null {
  const entries: AutocompleteEntry[] = [];
  let column = -1; // the description column, fixed by the first entry row that has a description
  for (let j = start; j < end; j++) {
    const t = texts[j]!;
    const entry = ENTRY_ROW.exec(t);
    if (entry !== null) {
      const at = 2 + entry[1]!.length + entry[2]!.length;
      if (column < 0) column = at;
      else if (at !== column) return null;
      entries.push({ name: entry[1]!, description: entry[3]!.trimEnd() });
      continue;
    }
    const bare = BARE_ENTRY_ROW.exec(t);
    if (bare !== null) {
      entries.push({ name: bare[1]!, description: "" });
      continue;
    }
    const cont = CONTINUATION_ROW.exec(t);
    if (cont === null) return null;
    const last = entries.at(-1);
    if (last === undefined || cont[1]!.length !== column) return null;
    // Claude soft-wraps the description at a word boundary, so the dropped break was a space.
    last.description = last.description === "" ? cont[2]!.trimEnd() : `${last.description} ${cont[2]!.trimEnd()}`;
  }
  return entries.length === 0 ? null : entries;
}

/** The detection result `claudeBuildBlocks` needs: the model plus `startLine`, the index of the
 *  popup's first row. Everything above it is the transcript plus the input box. */
export interface AutocompleteRegion {
  model: AutocompleteModel;
  startLine: number;
}

/**
 * Detect the completion popup at the tail of `lines`. Trailing blank rows are ignored (the terminal
 * pads the viewport), exactly as every other tail-anchored grammar does.
 *
 * Deliberately does NOT check that the input box is really there — that is the caller's to pair with
 * (`claudeBuildBlocks` gates on `hasInputBox`), which keeps this module free of any dependency on
 * chrome.ts and therefore free of the import cycle that would otherwise form: chrome.ts is the one
 * that peels this run before its own walk.
 */
export function detectAutocompleteRegion(lines: StyledLine[]): AutocompleteRegion | null {
  const texts = lines.map(lineText);
  let end = texts.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return null;

  const run = findAutocompleteRun(texts, end);
  return run === null ? null : { model: { entries: run.entries }, startLine: run.start };
}
