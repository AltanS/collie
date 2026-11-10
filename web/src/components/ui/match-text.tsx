import { Fragment, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/** One matched piece of a text, `[start, end)` in UTF-16 code units, the unit `String.slice` counts in. */
export type MatchRange = readonly [start: number, end: number];

export interface MatchTextProps {
  text: string;
  /** Sorted and merged by the caller. Anything else is clamped, never thrown on. */
  ranges?: readonly MatchRange[];
  /** Added to each `<mark>`. */
  className?: string;
}

/**
 * Cuts `text` into plain and marked pieces. A range is clamped into the text, an empty one is dropped,
 * and a range that begins inside the one before it begins where that one ended, so the pieces always
 * join back into exactly `text`.
 */
function pieces(text: string, ranges: readonly MatchRange[]): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  let cursor = 0;
  for (const [from, to] of ranges) {
    const start = Math.max(cursor, Math.min(Math.floor(from), text.length));
    const end = Math.min(Math.floor(to), text.length);
    if (!(end > start)) continue;
    if (start > cursor) out.push({ text: text.slice(cursor, start), hit: false });
    out.push({ text: text.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false });
  return out;
}

/**
 * A text with the matched letters marked: the one look for "this is the part you searched for", in
 * the theme token `--find`. The list filter's matched letters wear it, and so does Find in Chat.
 *
 * With no range it returns the bare string, so the caller's element holds the same one text node it
 * held before this component, and an empty filter changes nothing in the DOM. A mark is
 * `rounded-sm bg-find text-inherit` and nothing else: no padding, weight, size or border, because a
 * match repaints and never re-lays-out (DESIGN.md §2). The ground has alpha and the ink stays the
 * caller's own, so a mark reads on a current row (`bg-accent`) and on a blocked one alike. Owns no
 * matching: the ranges come from the caller.
 */
export function MatchText({ text, ranges, className }: MatchTextProps): ReactNode {
  if (ranges === undefined || ranges.length === 0) return text;
  const cut = pieces(text, ranges);
  if (!cut.some((piece) => piece.hit)) return text;
  return (
    <>
      {cut.map((piece, i) =>
        piece.hit ? (
          <mark key={i} className={cn("rounded-sm bg-find text-inherit", className)}>
            {piece.text}
          </mark>
        ) : (
          <Fragment key={i}>{piece.text}</Fragment>
        ),
      )}
    </>
  );
}
