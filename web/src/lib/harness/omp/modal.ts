// Positive evidence that one of omp's MODALS is on screen, and the shared reader of the key-hint list
// those modals print as their footer (.adr/0076).
//
// Why this exists. The unread-dialog card (.adr/0053) paints one button, the adapter's declared
// `cancelKey`, over a screen no grammar read, and it gates that on `composerReady` answering a
// definite `false`. omp could not use it for as long as `composerReady` was the only gate: omp's
// composer scanner has a total, permanent false-negative mode (one ZWJ emoji in a statusline template
// and `locateComposer` returns null on EVERY frame, omp/chrome.ts), so on such a pane `composerReady`
// is false forever and a card gated on it would sit over a live composer for good. This module is the
// fifth condition ADR 0053's addendum added for exactly that: the adapter also has to say it can SEE a
// modal, and it says so by reading the one thing every omp modal prints, the key that closes it.
//
// What counts. A footer row, near the buffer tail, that is a LIST of key hints whose LAST segment
// (or the one before the model picker's task-mode toggle, below) names its own way out in one of
// these spellings:
//
//   ⎋ cancel   ⎋ close   ⎋ to close          omp 18.4 and later (glyph keycaps)
//   Esc cancel   Esc close   Esc to close    omp 17.x to 18.1 (text keycaps; the approval dialog's
//                                            spelling is lower case, `esc cancel`)
//   󱊷 cancel  󱊷 close                        omp's Nerd Font symbol preset, where the keycap is the
//                                            private-use glyph U+F12B7 (nf-md-keyboard_esc), seen in
//                                            the `ask` tool captures of omp 18.4.4 (PR 336)
//
// `Esc to cancel` is NOT on that list on purpose. omp never prints it, Claude prints it on most of its
// modals, and a grammar that accepted it would be one step from reading another harness's screen.
// The match is case-insensitive only because the approval dialog spells the same word `esc`.
//
// ONE segment may follow the way out, and only one shape of it: the compact model picker (`/switch`,
// Alt+P) ends its footer `⎋ close · Alt+P task model`, and `Alt+P session model` in its task mode
// (`omp--v18-4-switch*.txt`; pi-tui `overlays/model-picker.ts` appends the task-mode key after the way
// out). Without this the picker's declined states (task mode, a search with no match, the Nerd Font
// preset) had no card, and the Keys drawer was the only way out. The trailing segment is a key token and
// the words `task model` or `session model`, nothing else, so a hint list that merely mentions Esc
// mid-list still reads false.
//
// Tail-anchored like every other grammar. The footer must be one of the last four non-blank rows, and
// every non-blank row below it must be box frame (a blank `│ │` row, the `╰──╯` bottom border, a bare
// rule), with ONE exception: the very last row may be anything, because omp paints a one-line usage
// strip under a tool-approval box (`omp--approval-bash.txt`). Every captured composer fails that walk by
// itself: a row of real text that is not the last row (the powerline in the box's top border,
// `╭── π … ──╮`, or the `❯ <draft>` row over a rule composer's status row) stands between the tail and
// any hint-shaped line above it. So a footer that has scrolled up, a transcript line that quotes
// `Esc cancel`, and a capture with a live composer under it all read `false`. The one shape that would
// not block is a box composer with no text in either border and an empty draft; that is uncaptured,
// and it matters only when `composerReady` has also failed to find that composer.
//
// What this does NOT cover, said plainly: `/tree`. Neither tree capture (`omp--tree.txt`,
// `omp--v18-4-tree.txt`) prints a way out at all: omp clips its hint row, and neither ends in an Esc
// segment. The picker gets no card from this module and stays the raw mirror it is today. Declaring it
// from its title instead would be reading a screen from one line, which is the failure ADR 0053 names.
//
// Pure functions over `StyledLine[]`. No I/O.

import type { StyledLine } from "../../blocks";
import { isBlank, lineText, rstrip } from "./markers";

/** How many non-blank rows from the tail the footer may sit: the approval box paints the footer, a
 *  blank box row, the bottom border and its usage strip, so the footer is the fourth. */
const FOOTER_WINDOW = 4;

/** The one segment a footer may END on. The spellings in the header; anything else is not a way out
 *  omp printed. */
const ESCAPE_SEGMENT = /^(?:⎋|esc|\u{F12B7})(?: (cancel|close)| to (close))$/iu;

/** The one segment allowed AFTER the way out: the model picker's task-mode toggle, a key token and
 *  `task model` or `session model` (see the header). Case-sensitive: omp prints it one way. */
const TASK_MODE_SEGMENT = /^[A-Za-z0-9+]+ (?:task|session) model$/;

/** A footer is short: the longest real one, the 17.x `/settings` footer, is 97 characters. The bound
 *  keeps a long transcript line from being read as a hint list. */
const MAX_FOOTER_CHARS = 160;
const MAX_SEGMENT_CHARS = 40;
const MIN_SEGMENTS = 2;
const MAX_SEGMENTS = 8;

/** Segments are joined with ` · ` everywhere except the approval dialog, which separates them with a
 *  run of spaces. */
const SEGMENT_SPLIT = /\s+·\s+|\s{2,}/;

/** Rows made only of box-drawing glyphs and spaces: the frame under a footer. */
const FRAME_ROW = /^[\s│├┤┬┴┼╭╮╰╯─┌┐└┘]+$/;

export interface OmpFooter {
  /** Every segment of the hint list, in screen order, trimmed (`⏎ select`, `⎋ cancel`). */
  segments: string[];
  /** The verb the last segment closes with, lower case: `cancel` or `close`. */
  escapeVerb: string;
}

/**
 * Read `text` as omp's key-hint list: two to eight short segments, the last one a way out (or the
 * model picker's task-mode toggle right after it, see the header). `text` is the list ALONE, with any
 * box side or `[ ]` bracket already taken off by the caller; an omp footer wears a different frame on
 * every screen, so the frame is the caller's business and the list is this function's. Null for
 * anything else, including a single `Esc cancel` with nothing beside it.
 */
export function readOmpHintList(text: string): OmpFooter | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_FOOTER_CHARS) return null;
  const segments = trimmed.split(SEGMENT_SPLIT).map((s) => s.trim());
  if (segments.length < MIN_SEGMENTS || segments.length > MAX_SEGMENTS) return null;
  if (segments.some((s) => s.length === 0 || s.length > MAX_SEGMENT_CHARS)) return null;
  const trailing = TASK_MODE_SEGMENT.test(segments[segments.length - 1]!) ? 1 : 0;
  // The way out still needs a hint beside it, so a task-mode toggle needs two segments before it.
  if (segments.length - trailing < MIN_SEGMENTS) return null;
  const escape = ESCAPE_SEGMENT.exec(segments[segments.length - 1 - trailing]!);
  if (escape === null) return null;
  return { segments, escapeVerb: (escape[1] ?? escape[2])!.toLowerCase() };
}

/**
 * One screen row read as a footer, or null. The row is either boxed (`│ <list> │`, every 18.x modal)
 * or a bare bracketed list (`  [<list>]`, the 17.x and 18.1 `/resume` picker). A bare row that is not
 * bracketed is prose, not a footer, so it is refused: the bracket is that screen's own evidence.
 */
function footerOfRow(text: string): OmpFooter | null {
  if (text.startsWith("│") && text.endsWith("│")) {
    const inner = text.slice(1, -1).trim();
    const bracketed = /^\[(.*)\]$/.exec(inner);
    return readOmpHintList(bracketed === null ? inner : bracketed[1]!);
  }
  const bare = /^\s*\[(.*)\]$/.exec(text);
  return bare === null ? null : readOmpHintList(bare[1]!);
}

/**
 * Whether one of omp's modals is on screen: a footer that names its own way out, at the tail. See the
 * header for what that means, why those spellings are the whole list, and why `/tree` is not on it.
 */
export function ompModalOnScreen(lines: StyledLine[]): boolean {
  let seen = 0;
  for (let i = lines.length - 1; i >= 0 && seen < FOOTER_WINDOW; i--) {
    const text = rstrip(lineText(lines[i]!));
    if (isBlank(text)) continue;
    seen++;
    if (footerOfRow(text) !== null) return true;
    if (FRAME_ROW.test(text)) continue;
    // The usage strip under an approval box: one row of anything, and only as the LAST row.
    if (seen === 1) continue;
    return false;
  }
  return false;
}
