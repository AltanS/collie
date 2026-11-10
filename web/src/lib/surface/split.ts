// The split-screen cut (.adr/0140 point 1): one rule, for every harness, applied where a read becomes
// rows. A screen split in two by a separator glyph (`│`, `┃`) painted in the same display column on
// every row, blank rows and rule rows included, is a split: the agent on the left, a panel on the
// right. Every row is cut at that column before a reader, the Surface or a compare sees it, so a box
// whose rules run into the panel is read as a box, and the panel's live values are no part of a
// compare.
//
// Never when the same rows carry a box-drawing glyph at column 0: that is a box filling the pane, not
// a split. Never when every row is blank left of the separator: that is a box with a margin. The
// leftmost such column is the cut, so a cut read cuts to itself again (the bridge cuts its read, and
// the readers it hands the rows to run the same cut).
//
// A dialog read from cut rows binds to the kept columns, 0 to the cut (`expected_columns`,
// lib/column-range.ts), so the bridge cuts its fresh read the same way before it compares.
//
// Pure, no harness name.
import { parseAnsi } from "../ansi";
import { lineText, splitLines, type StyledLine } from "../blocks";
import { cropLine, cropText } from "../column-range";
import { graphemeSegmenter } from "../env";
import { displayWidth } from "../text-width";

const SEPARATORS: ReadonlySet<string> = new Set(["│", "┃"]);
/** A box-drawing glyph (U+2500 to U+257F) in column 0. */
const BOX_AT_COLUMN_0 = /^[─-╿]/u;
/** Fewer rows than this are no screen to call split: a short read says nothing about a layout. */
const MIN_ROWS = 3;

/** The display columns of a row that hold a separator glyph. */
function separatorColumns(text: string): Set<number> {
  const out = new Set<number>();
  const segmenter = graphemeSegmenter();
  const clusters = segmenter === null ? Array.from(text) : Array.from(segmenter.segment(text), (s) => s.segment);
  let column = 0;
  for (const cluster of clusters) {
    if (SEPARATORS.has(cluster)) out.add(column);
    column += displayWidth(cluster);
  }
  return out;
}

/**
 * The display column a split screen is cut at, or null when the rows are no split. The read's trailing
 * empty rows (the empty row after a final line feed) are no rows of the screen and are left out.
 */
export function splitColumn(lines: readonly StyledLine[]): number | null {
  const texts = lines.map(lineText);
  let end = texts.length;
  while (end > 0 && texts[end - 1] === "") end--;
  if (end < MIN_ROWS) return null;
  const rows = texts.slice(0, end);
  if (rows.every((text) => BOX_AT_COLUMN_0.test(text))) return null;
  let common: number[] | null = null;
  for (const text of rows) {
    const columns = separatorColumns(text);
    common = (common ?? [...columns]).filter((column) => column > 0 && columns.has(column));
    if (common.length === 0) return null;
  }
  const column = Math.min(...(common ?? []));
  return rows.some((text) => cropText(text, column).trim() !== "") ? column : null;
}

/** The rows a reader reads: cut at the split's column when the screen is split, else as they are.
 *  `column` is the cut, or null when nothing was cut. */
export function cutSplit(lines: StyledLine[]): { rows: StyledLine[]; column: number | null } {
  const column = splitColumn(lines);
  return column === null ? { rows: lines, column } : { rows: lines.map((line) => cropLine(line, column)), column };
}

/** A pane read as the rows a reader reads: parsed, split into rows, and cut at a split. */
export function readRows(raw: string): StyledLine[] {
  return cutSplit(splitLines(parseAnsi(raw))).rows;
}
