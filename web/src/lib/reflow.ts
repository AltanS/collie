// Prose reflow for the native mirror.
//
// The problem: an agent lays paragraphs out at the pane's desktop width (~133 columns) with REAL
// newlines, and the phone rewraps each 133-column row at ~44 columns. Where the pane-width break
// lands mid-sentence the paragraph fragments: "something else. Send a" stranded on a short line
// with "screenshot of what you are seeing" starting the next. text-wrap:pretty cannot help — it
// never moves text across a hard break — so the join has to happen here, on StyledLines, before
// render.
//
// The rule joins row i with row i+1 (one space where the newline was) only when the pair looks
// like a wrapped paragraph: row i is long, ends mid-sentence, and carries a wrap point (a space)
// near its end; row i+1 is a small-indented lowercase continuation. Everything structured stays
// split: noWrap rows, blanks, fences, tables, box-drawing-led rows, block ends, mid-token breaks.
// A missed join renders exactly as today (the safe direction); a wrong join merges two lines with
// a space, readable in the mirror, lossy only in selection-copy.
//
// Placement matters more than the rule. This runs LAST in buildBlocks, over raw blocks only, after
// the unread-dialog post-pass: grammars detect on physical rows, the card's region and signature
// stay physical (the bridge binds taps against the grid it read), and find/links/copy derive from
// the same reflowed lines the mirror draws, so offsets stay consistent. The raw-terminal pref
// (grammars:false) skips it — the byte-faithful escape hatch stays byte-faithful.

import type { AnsiSegment } from "./ansi";
import { isBlank, lineText, type StyledLine } from "./blocks";

/** Wrapped rows run near the pane width (~133); structured rows rarely reach this. */
const MIN_WRAP_ROW = 100;
/** A wrapped continuation keeps at most a small layout indent; deeper means code. */
const CONTINUATION_INDENT_MAX = 3;
/** A wrap point needs a space within this many chars of the row end, else it broke mid-token. */
const WRAP_POINT_WINDOW = 20;

const HAS_ALNUM = /[A-Za-z0-9]/;
const LEAD_BOX = /^\s*[└├│┤┬┴┼─═<>|]/;
const TRAILING_CLOSERS = /["'"'"»”’) }\]>]+$/;
const BLOCK_END = /[.?!;:…]$/;
const TABLE_GLYPH = /[│┼┤├┬┴╞╪╡╢]/;
const ASCII_TABLE = /\|.*\|/;
const FENCE = /^\s*```/;
const LOWER_CONTINUATION = /^[a-z]/;

function wrapPointNearEnd(text: string): boolean {
  return /\s/.test(text.slice(-WRAP_POINT_WINDOW));
}

function endsMidSentence(text: string): boolean {
  return !BLOCK_END.test(text.replace(TRAILING_CLOSERS, ""));
}

function joinablePair(upper: string, lower: string): boolean {
  if (upper.length < MIN_WRAP_ROW) return false;
  if (!HAS_ALNUM.test(upper)) return false;
  if (LEAD_BOX.test(upper)) return false;
  if (!endsMidSentence(upper)) return false;
  if (!wrapPointNearEnd(upper)) return false;
  if (TABLE_GLYPH.test(upper) || TABLE_GLYPH.test(lower)) return false;
  if (ASCII_TABLE.test(upper) || ASCII_TABLE.test(lower)) return false;
  if (lower.includes("\t")) return false;
  const indent = lower.length - lower.trimStart().length;
  if (indent > CONTINUATION_INDENT_MAX) return false;
  return LOWER_CONTINUATION.test(lower.slice(indent));
}

function joinSpace(upper: StyledLine, lower: StyledLine): AnsiSegment {
  const left = upper.segments[upper.segments.length - 1];
  const right = lower.segments[0];
  const bg = left?.bg;
  // Both sides of one fill (a highlighted echo row): paint the space too, or the join leaves a
  // notch in the fill. Different backgrounds keep a bare space — merging fills would invent bytes.
  if (bg !== undefined && bg === right?.bg) {
    return { text: " ", style: { backgroundColor: bg }, muted: false, bg };
  }
  return { text: " ", style: {}, muted: false };
}

function joinLines(upper: StyledLine, lower: StyledLine, indent: number): StyledLine {
  const segments = [...upper.segments];
  const last = segments[segments.length - 1]!;
  const trimmedEnd = last.text.replace(/\s+$/, "");
  segments[segments.length - 1] = { ...last, text: trimmedEnd };
  segments.push(joinSpace(upper, lower));
  const [first, ...rest] = lower.segments;
  // The continuation indent is layout, not content: dropping it restores the logical line.
  segments.push({ ...first!, text: first!.text.slice(indent) }, ...rest);
  return { segments };
}

/**
 * Join wrapped prose rows inside one raw line list. Pure; returns the input array untouched
 * (same reference) when no pair joins, and reuses untouched line objects otherwise.
 */
export function reflowRawLines(input: StyledLine[]): StyledLine[] {
  let changed = false;
  let inFence = false;
  let lines = input;
  const out: StyledLine[] = [];
  let i = 0;
  while (i < lines.length) {
    const upper = lines[i]!;
    const upperText = lineText(upper);
    if (FENCE.test(upperText)) inFence = !inFence;
    const lower = !inFence && !FENCE.test(upperText) ? lines[i + 1] : undefined;
    const lowerText = lower !== undefined ? lineText(lower) : "";
    if (
      lower === undefined ||
      upper.noWrap === true ||
      lower.noWrap === true ||
      isBlank(upperText) ||
      isBlank(lowerText) ||
      FENCE.test(lowerText) ||
      !joinablePair(upperText, lowerText)
    ) {
      out.push(upper);
      i += 1;
      continue;
    }
    changed = true;
    const indent = lowerText.length - lowerText.trimStart().length;
    // The merged row keeps cascading: a three-row paragraph joins twice.
    lines = [...lines.slice(0, i), joinLines(upper, lower, indent), ...lines.slice(i + 2)];
  }
  return changed ? out.concat(lines.slice(i)) : lines;
}
