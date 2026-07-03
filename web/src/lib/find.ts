// Pure find-in-output helpers for the pane mirror. The mirror renders ANSI segments as React text
// nodes (never innerHTML — that's the XSS boundary), so "find" works over the *visible* text (the
// concatenation of the parsed segments' text, escapes already stripped) and highlighting is done by
// splitting a segment's own text around match ranges and wrapping the pieces in styled spans. No raw
// HTML is ever built here — this module only computes offsets.

export interface FindMatch {
  /** Start offset into the visible text (sum of segment texts, in order). */
  start: number;
  /** End offset (exclusive). */
  end: number;
}

/**
 * Case-insensitive substring search of `query` in `text`, returning every non-overlapping match as
 * a [start, end) range. An empty (or whitespace-only via the caller) query yields no matches.
 *
 * Offsets index the same string that's rendered, so callers can map ranges straight back onto the
 * rendered segments. Lower-casing both sides is ASCII-oriented (terminal output); the rare Unicode
 * character whose lower-case changes length would misalign, which we accept for this content.
 */
export function findMatches(text: string, query: string): FindMatch[] {
  if (!query) return [];
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle) return [];
  const matches: FindMatch[] = [];
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) break;
    matches.push({ start: idx, end: idx + needle.length });
    from = idx + needle.length; // non-overlapping
  }
  return matches;
}

/** A slice of a rendered segment: `matchIndex` = the global match it belongs to, or null if plain. */
export interface HighlightPiece {
  text: string;
  matchIndex: number | null;
}

/**
 * Split one rendered segment's `text` — which occupies [segStart, segStart + text.length) in the
 * visible string — into consecutive pieces, tagging each with the global match index it falls inside
 * (or null when it's outside every match). A match that straddles a segment boundary yields a tagged
 * piece in each segment carrying the *same* index, so a multi-segment (colour-changing) match still
 * highlights as one unit. `matches` must be sorted and non-overlapping (as findMatches returns).
 */
export function splitSegment(text: string, segStart: number, matches: FindMatch[]): HighlightPiece[] {
  if (matches.length === 0 || text.length === 0) return [{ text, matchIndex: null }];
  const segEnd = segStart + text.length;
  const pieces: HighlightPiece[] = [];
  let cursor = segStart; // absolute offset of the next unemitted char
  for (let mi = 0; mi < matches.length; mi++) {
    const m = matches[mi]!;
    if (m.end <= segStart) continue; // match ends before this segment
    if (m.start >= segEnd) break; // matches are sorted — the rest are past this segment
    const from = Math.max(m.start, segStart);
    const to = Math.min(m.end, segEnd);
    if (from > cursor) pieces.push({ text: text.slice(cursor - segStart, from - segStart), matchIndex: null });
    pieces.push({ text: text.slice(from - segStart, to - segStart), matchIndex: mi });
    cursor = to;
  }
  if (cursor < segEnd) pieces.push({ text: text.slice(cursor - segStart), matchIndex: null });
  return pieces;
}
