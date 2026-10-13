// A COLUMN RANGE of a bound region: the display columns of each row that a binding compares.
//
// WHY IT EXISTS. The bridge binds a write to the rows the phone saw (`expected_prompt`, matched as
// whole screen rows by bridge/prompt-binding.ts). A dialog that shares its rows with something that
// moves on its own, such as Oh My Pi's side panel, which ticks a clock beside the editor and the
// dialogs, can never match whole rows: the panel half of a row changes between the phone's read and
// the bridge's. A grammar that reads such a dialog from a known column range of its rows names that
// range on the model (`PromptModel.bindColumns`), the phone sends it as `expected_columns`, and the
// bridge cuts every row of its fresh read to the same range before it compares. A change outside the
// range does not refuse the tap; a change inside it does. Without a range nothing changes: whole rows.
//
// ONE FUNCTION FOR THE BRIDGE. {@link cropRawColumns} cuts raw pane text (escapes and all) to a range,
// counting columns exactly as the phone's `parseAnsi` + `displayWidth` see them: an escape sequence
// takes no column and is kept, so the colours of the kept cells survive for the style check; a
// grapheme cluster takes its display width and is kept only when every column it covers is in range.
// It lives under web/src/lib, beside `styled-region.ts`, and the bridge imports it by relative path.
//
// Pure, no harness imports.
import { graphemeSegmenter } from "./env";
import { displayWidth } from "./text-width";

/** Display columns `start` (inclusive) to `end` (exclusive) of every row of a bound region. A type
 *  literal, not an interface, so it is a plain JSON value wherever one is expected (the audit line). */
export type ColumnRange = { start: number; end: number };

/** The widest range the bridge accepts (`expected_columns`): no pane is this wide, so a bigger number
 *  is a malformed body. The bridge's body reader checks `0 <= start < end <= MAX_BIND_COLUMN`. */
export const MAX_BIND_COLUMN = 4096;

const ESC = String.fromCodePoint(0x1b);
const CSI_8BIT = String.fromCodePoint(0x9b);
const BEL = String.fromCodePoint(0x07);

/** The length of the escape sequence at `text[i]`, or 0 when none starts there. Mirrors `parseAnsi`:
 *  a CSI (7-bit or 8-bit) runs to its final byte, an OSC to BEL or ST, any other ESC takes one char. */
function escapeLength(text: string, i: number): number {
  const ch = text[i];
  if (ch !== ESC && ch !== CSI_8BIT) return 0;
  if (ch === CSI_8BIT || text[i + 1] === "[") {
    let j = i + (ch === CSI_8BIT ? 1 : 2);
    while (j < text.length && /[<=>?]/.test(text[j]!)) j++;
    while (j < text.length && /[0-9;:]/.test(text[j]!)) j++;
    while (j < text.length && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f) j++;
    return Math.min(text.length, j + 1) - i;
  }
  if (text[i + 1] === "]") {
    let j = i + 2;
    while (j < text.length && text[j] !== BEL && !(text[j] === ESC && text[j + 1] === "\\")) j++;
    if (text[j] === ESC) j++;
    return Math.min(text.length, j + 1) - i;
  }
  return Math.min(text.length, i + 2) - i;
}

/** A run of printable ASCII is one column per character, so it needs no segmenter. */
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

function clusters(text: string): string[] {
  const segmenter = graphemeSegmenter();
  return segmenter === null ? Array.from(text) : Array.from(segmenter.segment(text), (s) => s.segment);
}

/** One row of raw text cut to `range`, every escape kept (one past the range still resets the colours
 *  the next row starts from), and its line-ending CR (Herdr's reads are CRLF) kept too. */
function cropRawRow(line: string, range: ColumnRange): string {
  const crlf = line.endsWith("\r");
  const row = crlf ? line.slice(0, -1) : line;
  let out = "";
  let column = 0;
  let i = 0;
  while (i < row.length) {
    const esc = escapeLength(row, i);
    if (esc > 0) {
      out += row.slice(i, i + esc);
      i += esc;
      continue;
    }
    // A run of visible text up to the next escape, cut into clusters so a wide glyph or a combining
    // mark is measured whole, as the phone measures it.
    let j = i;
    while (j < row.length && escapeLength(row, j) === 0) j++;
    const run = row.slice(i, j);
    i = j;
    if (column >= range.end) continue;
    if (PRINTABLE_ASCII.test(run)) {
      // One column per character: the kept part is a slice.
      out += run.slice(Math.max(0, range.start - column), Math.max(0, range.end - column));
      column += run.length;
      continue;
    }
    for (const cluster of clusters(run)) {
      // A carriage return takes no column and is always kept: the bridge's normalisation reads it as
      // a line break, so dropping it would join two rows.
      if (cluster === "\r") {
        out += cluster;
        continue;
      }
      const width = displayWidth(cluster);
      if (column >= range.start && column + width <= range.end) out += cluster;
      column += width;
    }
  }
  return crlf ? `${out}\r` : out;
}

/**
 * Raw pane text with every row cut to `range`: escape sequences are kept, visible cells outside the
 * range are dropped, a wide glyph that crosses either edge is dropped whole. Rows stay rows, so the
 * bridge's text and style projections of the result line up exactly as they do for the whole read.
 */
export function cropRawColumns(text: string, range: ColumnRange): string {
  return text
    .split("\n")
    .map((row) => cropRawRow(row, range))
    .join("\n");
}
