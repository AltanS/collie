// A URL THE BOX BROKE — Claude Code's boxes wrap their text at, or just short of, the last content
// column, so a login URL longer than the width comes out as several rows. This joins those rows back
// into one line, so the link finder sees the whole address.
//
// The box moves a word that does not fit on to the next row whole, and cuts inside a word only when
// the word is longer than the content width. So length is the one sign a break can be read by, and
// the continuation's own shape is never looked at: a cut inside the host, the path, the query or the
// device code (`user_code=AB` / `CD-EFGH`, `ABCD` / `-EFGH`) joins alike. The box cuts such a word
// at the last content column, or short of it next to a `/`. A row joins the next when
//
//   1. its last word is an http(s) URL that fills the row to the last content column, or ends short
//      of it with a `/` at the break: the URL ends in `/`, or the next row starts with one; and
//   2. that URL, counted from where it starts on the earliest joined row, plus the next row's first
//      word is longer than the content width: the two could not have stood on one row.
//
// A join adds no character, and drops only the padding of a row short of the edge.
//
// Every other break stays: a URL short of the edge with no `/` at the break, or one on the edge
// whose next word is short enough to have fitted (`device` / `Then`). The card then links only the
// fragment on its row, as the mirror does. The joined line's last word is tested again against the
// row after it, so a URL over three rows joins, and a row that finishes one URL and starts another
// joins on both sides.
//
// Two shapes are joined wrongly and accepted: a complete URL that truly ends on the last column, or
// a complete URL ending in `/` at the end of its row, followed by a word long enough to pass the
// length test, such as a URL alone on its row followed by `--profile`. The card then links the glued
// address. The rows give nothing more to tell either from a cut, and the Screen pill, which shows the
// box's own rows, is the way out.

const ADDRESS = /^https?:\/\//i;

function filledToLastColumn(row: string, contentWidth: number): boolean {
  return row.length === contentWidth && row[contentWidth - 1] !== " ";
}

function lastWordStart(line: string): number {
  let index = line.length;
  while (index > 0 && !/\s/.test(line[index - 1]!)) index--;
  return index === line.length ? -1 : index;
}

function firstWordLength(row: string): number {
  const space = row.indexOf(" ");
  return space === -1 ? row.length : space;
}

function continuesAddress(line: string, last: string, next: string, contentWidth: number): boolean {
  const filled = filledToLastColumn(last, contentWidth);
  const text = filled ? line : line.trimEnd();
  const start = lastWordStart(text);
  if (start === -1 || !ADDRESS.test(text.slice(start))) return false;
  if (!filled && !text.endsWith("/") && !next.startsWith("/")) return false;
  const nextWord = firstWordLength(next);
  return nextWord > 0 && text.length - start + nextWord > contentWidth;
}

/** The rows with each address the box broke at its right edge joined to its continuation rows. */
export function joinBrokenUrls(rows: readonly string[], contentWidth: number): string[] {
  const lines: string[] = [];
  let at = 0;
  while (at < rows.length) {
    let line = rows[at]!;
    let last = line;
    at++;
    while (at < rows.length && continuesAddress(line, last, rows[at]!, contentWidth)) {
      if (!filledToLastColumn(last, contentWidth)) line = line.trimEnd();
      last = rows[at]!;
      line += last;
      at++;
    }
    lines.push(line);
  }
  return lines;
}
