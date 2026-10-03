// The CANONICAL STYLED REGION: a screen region as text plus style per cell, and nothing else
// (ADR 0080 point 7).
//
// WHY IT EXISTS. The bridge binds a keystroke to the screen the phone saw by comparing text
// (`normalizePromptRegion` in bridge/prompt-binding.ts strips every SGR escape first). A grammar
// whose pointer is drawn only as a style (opencode's permission chips: a background colour, no
// glyph) therefore looks the same to the bridge with the pointer on any chip. This module gives both
// sides one projection of the grid that keeps the style, so the bridge can compare it without
// holding a grammar.
//
// ONE FUNCTION, TWO CALLERS. {@link canonicalStyledLines} works over the spans `parseAnsi` already
// produced, so the phone calls it on a region's StyledLines. {@link styledRegionLines} parses raw
// text first and calls the same function, so the bridge calls it on the bytes of a pane read. There
// is exactly one SGR parser (`ansi.ts`); this file adds no grammar and no terminal emulation
// (ADR 0008). It lives under web/src/lib and is imported by bridge/prompt-binding.ts by relative
// path, the way scripts/harness-canary/ already imports web/src/lib/json.
//
// THE CANONICAL FORM depends only on the visible grid, never on which escape sequences encoded it:
//
//   - A line is a list of RUNS. Adjacent cells of the same style are one run, so `ESC[1;31mX` and
//     `ESC[31mESC[1mX` give the same line, and so does splitting or merging same-style runs.
//   - The first run of every line is tagged, whatever the previous line left behind, so the form does
//     not depend on how the multiplexer serialised state across a line break. Later runs are tagged
//     because the style changed.
//   - A cell that is whitespace shows no foreground, weight or slant, so what it carries of those is
//     ignored: it takes them from the cell before it (the plain style at the start of a line), which
//     keeps a spaced phrase one run. Its background, underline and strike-through are visible and
//     are kept.
//   - Trailing whitespace is dropped whatever its style, and a line that is then empty is dropped,
//     exactly as `normalizePromptRegion` does for text. Leading and inner spacing survive.
//
// THE WIRE VALUE. The phone sends a region as `expected_styled`: a first line naming the format, then
// the canonical lines, joined by "\n" ({@link encodeStyledRegion}). The format line exists so the
// canonical form can change later without a phone and a bridge of different ages refusing every tap
// of a pane: a bridge that does not know the version skips the style check and keeps the text check.
//
// A run is `US tag US text`, where US is U+001F. The tag is `-` for the plain style, else the
// comma-joined `fg=…`, `bg=…`, `b`, `d`, `i`, `u`, `s` that are set, in that order. U+001F and U+001E
// are control characters with no visible form, so they are removed from the text; nothing a pane
// prints can then forge a tag. A line never holds a newline, so a region is its lines joined by "\n".

import { parseAnsi } from "./ansi";
import { splitLines } from "./blocks";

/** The style fields a span carries. `AnsiSegment` has all of them. Inverse video is already resolved
 *  into `fg` and `bg` by `parseAnsi`, so it is not a field of its own. */
export interface StyleSpan {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}

/** One visual line of spans (`StyledLine` has this shape). */
export interface SpanLine {
  segments: readonly StyleSpan[];
}

const UNIT_SEPARATOR = String.fromCodePoint(0x1f);
// The two controls are spliced in from their code points, not written as escapes in a literal:
// matching them IS the point here (the same way bridge/prompt-binding.ts matches ESC).
const CONTROL_IN_TEXT = new RegExp(`[${String.fromCodePoint(0x1e)}${UNIT_SEPARATOR}]`, "g");

/** The style fields a cell shows, with the same names as {@link StyleSpan} minus the text. */
type CellStyle = Omit<StyleSpan, "text">;

/** The style a cell SHOWS. A blank cell shows no foreground, weight or slant, so it takes those from
 *  the cell before it (`before`), and keeps its own background, underline and strike-through. */
function shownStyle(span: StyleSpan, blank: boolean, before: CellStyle | undefined): CellStyle {
  if (!blank) return span;
  return {
    fg: before?.fg,
    bg: span.bg,
    bold: before?.bold,
    dim: before?.dim,
    italic: before?.italic,
    underline: span.underline,
    strike: span.strike,
  };
}

/** The canonical tag of one cell's shown style. */
function styleTag(style: CellStyle): string {
  const parts: string[] = [];
  if (style.fg) parts.push(`fg=${style.fg}`);
  if (style.bg) parts.push(`bg=${style.bg}`);
  if (style.bold) parts.push("b");
  if (style.dim) parts.push("d");
  if (style.italic) parts.push("i");
  if (style.underline) parts.push("u");
  if (style.strike) parts.push("s");
  return parts.length === 0 ? "-" : parts.join(",");
}

/** One line of spans as runs of (tag, text), adjacent cells of one style merged, trailing
 *  whitespace dropped. Empty when the line shows nothing. */
function lineRuns(line: SpanLine): { tag: string; text: string }[] {
  const runs: { tag: string; text: string }[] = [];
  let before: CellStyle | undefined;
  for (const span of line.segments) {
    for (const ch of span.text.replace(CONTROL_IN_TEXT, "")) {
      before = shownStyle(span, /\s/.test(ch), before);
      const tag = styleTag(before);
      const last = runs[runs.length - 1];
      if (last !== undefined && last.tag === tag) last.text += ch;
      else runs.push({ tag, text: ch });
    }
  }
  while (runs.length > 0) {
    const last = runs[runs.length - 1]!;
    last.text = last.text.replace(/\s+$/, "");
    if (last.text.length > 0) break;
    runs.pop();
  }
  return runs;
}

/**
 * The canonical lines of a region of spans: one string per line that shows something, in order.
 * The shared core: the phone passes a region's StyledLines, the bridge goes through
 * {@link styledRegionLines}. The two must produce identical strings for the same bytes.
 */
export function canonicalStyledLines(lines: readonly SpanLine[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const runs = lineRuns(line);
    if (runs.length === 0) continue;
    out.push(runs.map((r) => `${UNIT_SEPARATOR}${r.tag}${UNIT_SEPARATOR}${r.text}`).join(""));
  }
  return out;
}

/** The canonical lines of raw ANSI text, as the bridge reads a pane: `parseAnsi` and `splitLines`
 *  (the phone's own pipeline), then {@link canonicalStyledLines}. */
export function styledRegionLines(ansiText: string): string[] {
  return canonicalStyledLines(splitLines(parseAnsi(ansiText)));
}

/** The format line of the wire value. A change to the canonical form above is a new version. */
export const STYLED_FORMAT = "v1";

/** The wire value of a region's canonical lines: the format line, then the lines, joined by "\n".
 *  This is what `PromptModel.styledSignature` holds and `expected_styled` carries. */
export function encodeStyledRegion(lines: readonly string[]): string {
  return [STYLED_FORMAT, ...lines].join("\n");
}

/**
 * Split a wire value into its format line and its canonical lines (empty lines dropped, as no
 * canonical line is empty). The version is NOT judged here: the caller decides what an unknown one
 * means. `null` for the empty string, which has no first line at all and is malformed under every
 * version.
 */
export function decodeStyledRegion(value: string): { version: string; lines: string[] } | null {
  if (value.length === 0) return null;
  const [version = "", ...rest] = value.split("\n");
  return { version, lines: rest.filter((line) => line.length > 0) };
}
