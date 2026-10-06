// Find hits and autolinks laid over keyed rows (port of the two splits in
// web/src/components/ansi-output.tsx). Both are ranges over ONE coordinate space: the mirror's lines
// joined by "\n" (`haystack`), which is the text web's `findMatches` and `findLinks` read. A span
// that a range crosses is cut at the range's edges; the cut spans carry `mark` and `href`, and
// Screen draws them as a highlight and an anchor.
//
// A row no range touches comes back as the same object, so a search costs only the rows it lights.
import type { FindMatch } from "@web/lib/find";
import type { LinkMatch } from "@web/lib/links";
import type { StyledLine } from "@web/lib/blocks";
import { cellPieces } from "@web/lib/cell-glyphs";

import type { Row, Span } from "./rows";

/** A line's visible text: its segments, joined. */
export function lineText(line: StyledLine): string {
  let out = "";
  for (const seg of line.segments) out += seg.text;
  return out;
}

/** The lines joined into one haystack, and each line's start offset in it. */
export interface Haystack {
  text: string;
  starts: number[];
}

/** The haystack and each line's start offset in it. */
export function haystackOf(lines: readonly StyledLine[]): Haystack {
  const starts: number[] = [];
  let text = "";
  lines.forEach((line, i) => {
    if (i > 0) text += "\n";
    starts.push(text.length);
    text += lineText(line);
  });
  return { text, starts };
}

interface Range {
  start: number;
  end: number;
}

function overlapping<T extends Range>(ranges: readonly T[], start: number, end: number): T[] {
  return ranges.filter((r) => r.start < end && r.end > start);
}

/** Cut one span at the edges of the ranges that cross it. `at` is the span's start offset. */
function cutSpan(span: Span, at: number, matches: readonly FindMatch[], current: number, links: readonly LinkMatch[]): Span[] {
  const end = at + span.text.length;
  const hits = overlapping(matches, at, end);
  const urls = overlapping(links, at, end);
  if (hits.length === 0 && urls.length === 0) return [span];
  const cuts = new Set<number>([at, end]);
  for (const r of [...hits, ...urls]) {
    if (r.start > at && r.start < end) cuts.add(r.start);
    if (r.end > at && r.end < end) cuts.add(r.end);
  }
  const points = [...cuts].toSorted((a, b) => a - b);
  const out: Span[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i]!;
    const to = points[i + 1]!;
    const text = span.text.slice(from - at, to - at);
    const hit = hits.find((m) => m.start < to && m.end > from);
    const url = urls.find((l) => l.start < to && l.end > from);
    const piece: Span = { ...span, text, pieces: cellPieces(text) };
    if (hit) piece.mark = matches.indexOf(hit) === current ? "current" : "other";
    if (url) piece.href = url.href;
    out.push(piece);
  }
  return out;
}

/**
 * Lay `matches` (focused one at index `current`) and `links` over `rows`. `lines` are the styled
 * lines the rows were built from, index for index.
 */
export function decorateRows(
  rows: readonly Row[],
  lines: readonly StyledLine[],
  starts: readonly number[],
  matches: readonly FindMatch[],
  current: number,
  links: readonly LinkMatch[],
): Row[] {
  if (matches.length === 0 && links.length === 0) {
    // SAFETY: only the readonly view narrows; the rows come back untouched and no caller mutates them.
    return rows as Row[];
  }
  return rows.map((row, i) => {
    const line = lines[i];
    const start = starts[i];
    if (line === undefined || start === undefined) return row;
    const end = start + lineText(line).length;
    if (overlapping(matches, start, end).length === 0 && overlapping(links, start, end).length === 0) return row;
    let at = start;
    const spans: Span[] = [];
    for (const span of row.spans) {
      spans.push(...cutSpan(span, at, matches, current, links));
      at += span.text.length;
    }
    return { ...row, sig: `${row.sig}\u0003decorated`, spans };
  });
}
