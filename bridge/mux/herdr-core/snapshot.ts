// A bounded extraction of hc's first-paint snapshot (0.1.15, HC_API.md), NOT a VT emulator.
// The core already rendered the cells. Its formatter writes them in row order between home and
// cursor restoration. Accept only that measured form; never interpret movement or live output.
import { parseAnsi } from "../../../web/src/lib/ansi.ts";
import { lineText, splitLines } from "../../../web/src/lib/blocks.ts";
import { cellsByColumn, displayWidth } from "../../../web/src/lib/text-width.ts";
import { stripSgr } from "../../../web/src/lib/surface/plain.ts";

const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);
// Measured input/reporting and screen-selection modes only. Unknown modes can change the
// meaning of the grid (for example origin or screen reverse); never silently discard those.
const PREFIX_MODE = "(?:1|7|9|25|47|66|100[0-6]|101[56]|104[79]|2004|2026|2031|2048)";
const PREFIX_CONTROL = new RegExp(`${ESC}\\[(?:!p|\\?${PREFIX_MODE}[hl]|=[0-9;]+u|[0-9]*[GgHJ])|${ESC}H`, "g");
const CURSOR = new RegExp(`${ESC}\\[(\\d+);(\\d+)H`);
const METADATA = new RegExp(`${ESC}\\[=[0-9;]+u|${ESC}\\[\\?9001[hl]|${ESC}\\](?:2|7501);[^${ESC}${BEL}]*(?:${BEL}|${ESC}\\\\)`, "g");
const WIN32_MODE = new RegExp(`${ESC}\\[\\?9001[hl]`);
const STATUS = new RegExp(`${ESC}\\]7501;[^${ESC}${BEL}]*(?:${BEL}|${ESC}\\\\)`, "y");

export interface SnapshotSize {
  readonly cols: number;
  readonly rows: number;
  /** Root status plus named records: first_paint appends exactly this many OSC 7501 reports. */
  readonly reports: number;
}

/** The core appends win32 mode and every status record after the formatter's paint. Its outbox
 * can split that paint or coalesce later live output into the same DATA frame. This boundary is
 * independent of DATA frames; bytes after it are not interpreted. Latin-1 input gives byte offsets.
 */
export function firstPaintEnd(paint: string, reports: number): number | null {
  if (!Number.isInteger(reports) || reports < 0) return null;
  const mode = WIN32_MODE.exec(paint);
  if (mode === null) return null;
  let end = mode.index + mode[0].length;
  for (let i = 0; i < reports; i++) {
    STATUS.lastIndex = end;
    if (STATUS.exec(paint) === null) return null;
    end = STATUS.lastIndex;
  }
  return end;
}

function containsControl(text: string, allowNewline = false): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if ((code < 0x20 && !(allowNewline && code === 0x0a)) || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** Rendered text + SGR only, or null when the snapshot cannot prove the plain read's whole grid.
 * The separate reads are not atomic: mismatched text or dimensions must not produce styled facts.
 */
export function styledSnapshot(
  paint: string,
  screen: { readonly text: string; readonly complete: boolean },
  size: SnapshotSize,
): string | null {
  if (!Number.isInteger(size.cols) || !Number.isInteger(size.rows) || size.cols <= 0 || size.rows <= 0) return null;
  const paintEnd = firstPaintEnd(paint, size.reports);
  if (paintEnd === null) return null;
  paint = paint.slice(0, paintEnd);
  const clear = paint.indexOf("\x1b[2J");
  const home = clear < 0 ? -1 : paint.indexOf("\x1b[H", clear + 4);
  if (home < 0) return null;
  // Only the reset/mode/tab-stop setup seen before the formatter's home. Unknown setup declines.
  const prefix = paint.slice(0, home).replace(PREFIX_CONTROL, "");
  if (prefix !== "") return null;
  const body = paint.slice(home + 3);
  const cursor = CURSOR.exec(body);
  if (cursor === null || !screen.complete) return null;
  const grid = body.slice(0, cursor.index).replace(/\r\n/g, "\n");
  // Every escape that crosses MuxGrid must be SGR. A cursor command hidden by parseAnsi is not safe.
  if (containsControl(stripSgr(grid), true)) return null;
  const rows = splitLines(parseAnsi(grid));
  const textRows = rows.map(lineText);
  const plainRows = screen.text.split("\n").map((row) => row.trimEnd());
  if (textRows.length !== size.rows || plainRows.length !== size.rows ||
      textRows.some((row, i) => row.trimEnd() !== plainRows[i] || displayWidth(row) > size.cols)) return null;
  const y = Number(cursor[1]), x = Number(cursor[2]);
  if (y < 1 || y > size.rows || x < 1 || x > size.cols) return null;
  const tail = body.slice(cursor.index + cursor[0].length).replace(METADATA, "");
  const repeated = stripSgr(tail);
  if (containsControl(repeated)) return null;
  if (repeated !== "") {
    // Pending wrap is restored by reprinting the SAME last-column grapheme and style. Ignoring
    // that restoration without checking it duplicates a cell, or conceals a different write.
    const cell = [...cellsByColumn(textRows[y - 1]!)].find(([column]) => column === x - 1)?.[1];
    if (cell !== repeated || x - 1 + displayWidth(cell) !== size.cols) return null;
    let offset = 0;
    for (const [column, cluster] of cellsByColumn(textRows[y - 1]!)) {
      if (column === x - 1) break;
      offset += cluster.length;
    }
    let end = 0;
    const original = rows[y - 1]!.segments.find((span) => { end += span.text.length; return end > offset; });
    const restored = parseAnsi(grid + tail).at(-1);
    const fields = ["fg", "bg", "bold", "dim", "italic", "underline", "strike"] as const;
    if (original === undefined || restored === undefined ||
        fields.some((key) => (original[key] || undefined) !== (restored[key] || undefined))) return null;
  }
  return grid;
}
