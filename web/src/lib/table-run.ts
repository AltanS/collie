// Which rows of the mirror are a TABLE — the one shape that Wrap lines gets wrong.
//
// Wrap is right for almost everything: the pane was rendered at the desktop's column count and a
// phone shows far fewer, so prose has to reflow ([ADR 0008](../../../.adr/0008-collie-does-not-run-a-terminal-emulator.md),
// issue #53). A table is the exception, and it is the exception for a structural reason rather than
// an aesthetic one: its meaning is carried by the COLUMN a character sits in, and wrapping destroys
// exactly that. Reflowed, row three's second cell lands under row two's third — the rows are all
// still there and the table is unreadable. So a table run is panned inside its own scroller while
// the mirror around it keeps wrapping (components/ansi-output.tsx).
//
// This can only recover the columns between the phone's width and the PANE'S width. A table already
// too wide for the pane was hard-wrapped by the terminal before Collie ever saw it — `pane.read`
// returns a rendered grid, not logical lines — and no amount of CSS gets those rows back. Neither
// half of such a row carries the table's own separator count, so both fall out of the run and keep
// wrapping rather than dragging a broken table into a scroller.
//
// TWO GRAMMARS, EACH ANCHORED ON A ROW THAT CANNOT BE ANYTHING ELSE, THEN GROWN BY COUNT. The two
// halves are the whole safety argument. A row is never claimed for being pipe-ish or box-ish on its
// own: it must sit in the contiguous neighbourhood of a delimiter no other construct prints, AND
// divide into the same number of columns as that delimiter.
//
//   · Markdown — the anchor is the delimiter row (`| --- | --- |`, or the same without outer pipes),
//     and the count is its pipes. Prose that happens to contain a pipe cannot match a count it never
//     had.
//   · Box drawing — the anchor is a frame row carrying a CROSS (`├───┼───┤`), and the count is its
//     crosses. A T-piece is not enough and the reason is load-bearing: see BOX_CROSS_GLYPH_CLASS.
//     Claude's input box has neither, being a single-column frame (`╭───╮`, `│ > … │`, `╰───╯`).
//     Neighbours join as frame rows spending that count on junctions, or as content rows spending it
//     on verticals — plus two more when the table is drawn with outer borders.
//
// A blank line always ends a run, in both grammars — it is the one separator every harness prints
// around a table, and it stops an anchor reaching across unrelated output.

import { isBlank, lineText, type StyledLine } from "./blocks";
import {
  BOX_COLUMN_JUNCTION_GLYPH_CLASS,
  BOX_CROSS_GLYPH_CLASS,
  BOX_DRAWING_RULE_GLYPH_CLASS,
  BOX_VERTICAL_GLYPH_CLASS,
} from "./rule-glyphs";

/** A contiguous, inclusive range of line indices to pan as one unit. */
export interface TableRun {
  readonly start: number;
  readonly end: number;
}

/** Stable empty result, frozen: it is shared by every table-free call, so a caller that pushed into
 *  it would corrupt every later one. */
const NO_RUNS: readonly TableRun[] = Object.freeze([]);

// A GFM delimiter row: two or more dash cells, optional alignment colons, optional outer pipes. The
// interior pipe is what the `+` demands, so a bare rule (`------`) is not a table and neither is a
// single pipe-less cell.
const MD_DELIMITER = /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?$/;
const PIPE = /\|/g;

// The `+---+---+` rule of mysql, sqlite3 -table, psql, docker, tabulate and comfy-table — the most
// common table an agent pastes out of a shell tool, after markdown.
const ASCII_DELIMITER = /^\+(?:-+\+)+$/;
const PLUS = /\+/g;
const ASCII_SEPARATOR = /^[|+]$/;

// A row whose every printable character is box drawing: a frame row, top, bottom or divider.
const BOX_FRAME_ROW = new RegExp(`^[${BOX_DRAWING_RULE_GLYPH_CLASS}\\s]+$`);
// The anchor is a CROSS and never a T-piece. A `┬` sits wherever ANY two-pane box's divider meets
// its top border and a `┴` where it meets the bottom, so a T-piece anchor claimed omp's splash
// screen and the whole of its /model picker — 18 of the 121 committed pane fixtures. A cross is a
// column boundary crossing a ROW boundary, which only a table draws. The trade is a headerless box
// table, with no interior divider row, which is now left to wrap; that is the cheap failure.
const BOX_CROSS = new RegExp(`[${BOX_CROSS_GLYPH_CLASS}]`);
// Interior junctions carry the anchor's column offsets. Corners and side tees (`┌ ┐ ├ ┤`) are not
// here: they mark where the FRAME is, and a lid draws a corner where a content row draws a border,
// so an offset taken from one would never match the other.
const BOX_JUNCTION = new RegExp(`[${BOX_COLUMN_JUNCTION_GLYPH_CLASS}]`, "g");
// What may stand at a column offset on a member row: a cell wall, or another row's junction.
const BOX_SEPARATOR = new RegExp(`^[${BOX_VERTICAL_GLYPH_CLASS}${BOX_COLUMN_JUNCTION_GLYPH_CLASS}]$`);

/**
 * The table runs in a block's lines, in order, non-overlapping, each at least two lines long.
 *
 * Pure, and cheap enough to run on every unique poll text: up to three regex tests per line to find
 * an anchor, plus one membership probe per line an anchor tries to grow over. The renderer memoises
 * it anyway, because the mirror re-renders far more often than its text changes.
 */
export function tableRuns(lines: StyledLine[]): readonly TableRun[] {
  // Two views of each line. `grid` keeps the left padding, because the box and ASCII grammars agree
  // on column OFFSETS and those only line up in the terminal's own coordinates. `text` is fully
  // trimmed, which is what lets an indented markdown table anchor at all.
  const grid = lines.map((line) => lineText(line).trimEnd());
  const runs: TableRun[] = [];
  // The first line of the next run may not reach back into the previous one.
  let floor = 0;

  for (let i = 0; i < lines.length; i++) {
    if (i < floor) continue;
    const row = grid[i]!;
    if (isBlank(row)) continue;
    const text = row.trimStart();

    const member = MD_DELIMITER.test(text)
      ? markdownMember(text.match(PIPE)?.length ?? 0)
      : ASCII_DELIMITER.test(text)
        ? offsetMember(offsetsOf(row, PLUS), ASCII_SEPARATOR)
        : BOX_FRAME_ROW.test(text) && BOX_CROSS.test(text)
          ? offsetMember(offsetsOf(row, BOX_JUNCTION), BOX_SEPARATOR)
          : null;
    if (!member) continue;

    let start = i;
    while (start > floor && member(grid[start - 1]!)) start--;
    let end = i;
    while (end + 1 < lines.length && member(grid[end + 1]!)) end++;
    floor = end + 1;
    // One row is a delimiter with nothing to delimit — leave it to the ordinary wrap.
    if (end === start) continue;
    runs.push({ start, end });
  }

  return runs.length > 0 ? runs : NO_RUNS;
}

/** Where the anchor's separators stand, in terminal columns. */
function offsetsOf(row: string, separator: RegExp): number[] {
  const at: number[] = [];
  separator.lastIndex = 0;
  for (let m = separator.exec(row); m; m = separator.exec(row)) at.push(m.index);
  return at;
}

/** A markdown row of the anchor's shape. The count includes the outer pipes, so it also pins
 *  whether the table is written with them — a delimiter row that omits the outer pipes its data
 *  rows carry is refused, which is the deliberate strict half of this rule. Markdown alone is
 *  matched by COUNT rather than by offset, because a model routinely prints a table whose columns
 *  do not line up; a grid-drawn one always does. */
function markdownMember(pipes: number): (text: string) => boolean {
  return (row) => {
    const text = row.trimStart();
    return !isBlank(text) && (text.match(PIPE)?.length ?? 0) === pipes;
  };
}

/**
 * A row that carries a separator at every one of the anchor's column offsets — the grid grammars'
 * agreement rule, and it is what four otherwise separate refusals all reduce to.
 *
 *   · A row the terminal already wrapped keeps no separator at those offsets, so neither half joins
 *     and the wreckage is left to wrap instead of being dragged into the scroller half-panned.
 *   · A TITLED lid (`┌─ Results ──┬───┐`) DOES carry one, so the run keeps its own top border even
 *     though the letters in it stop it being a frame row.
 *   · A plain rule drawn next to a table carries `─` there, not a wall, so the run stops at it.
 *   · A single-column chrome box below a table — Claude's input box — has walls only at its own two
 *     edges, so a multi-column anchor cannot grow into it even with no blank line between them.
 *
 * The cost is a table whose cells hold double-width characters: the terminal's columns and the
 * string's indices stop agreeing, no offset matches, and the table wraps as it did before.
 */
function offsetMember(offsets: number[], separator: RegExp): (row: string) => boolean {
  return (row) => {
    if (isBlank(row)) return false;
    return offsets.every((at) => separator.test(row.charAt(at)));
  };
}
