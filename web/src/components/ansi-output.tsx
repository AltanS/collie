import { memo, useEffect, useMemo, useRef } from "react";
import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";
import { parseAnsi, type AnsiSegment } from "@/lib/ansi";
import { findMatches, splitSegment, type FindMatch } from "@/lib/find";

export interface AnsiOutputProps {
  text: string;
  className?: string;
  /** false = no wrap; the block scrolls horizontally, preserving column alignment. Default true. */
  wrap?: boolean;
  /** Monospace font size in px. Default 11. */
  fontSize?: number;
  /** Active find query. Empty (the default) = not searching: the fast, allocation-free render path. */
  query?: string;
  /** Index of the focused match — highlighted stronger and scrolled into view. -1 = none. */
  currentMatch?: number;
  /** Reports the current match count back to the parent (drives the find bar's "3/17"). */
  onMatchCount?: (count: number) => void;
}

// Stable empty result so the "not searching" path keeps the same `matches` reference across polls
// (no needless effect re-runs / parent count updates while find is closed).
const NO_MATCHES: FindMatch[] = [];

function preClass(wrap: boolean, className?: string): string {
  return cn(
    "m-0 font-mono leading-[1.35] text-foreground/90",
    wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre overflow-x-auto",
    className,
  );
}

// Faithful, colored mirror of a pane's recent terminal output. Text is always rendered as React
// text nodes (escaped); only color/weight come from the ANSI parse — no XSS surface.
//
// Find-in-output highlights matches by splitting each parsed segment's *text* around the match
// ranges and wrapping the matched slices in styled <span>s (still React text nodes — the XSS
// boundary is untouched). The current match gets a stronger intensity and is scrolled into view.
//
// Performance: parseAnsi runs once per unique `text` value (useMemo), and React.memo prevents
// re-renders when props are unchanged — critical for the 1.5 s polling cadence on mobile. When not
// searching (`query` empty) the render is identical to before (one span per segment).
export const AnsiOutput = memo(function AnsiOutput({
  text,
  className,
  wrap = true,
  fontSize = 11,
  query = "",
  currentMatch = -1,
  onMatchCount,
}: AnsiOutputProps) {
  const segments = useMemo(() => parseAnsi(text), [text]);

  // Matches live in offsets over the *visible* text (concatenated segment text). The join only runs
  // while actually searching, so the idle polling path pays nothing.
  const matches = useMemo(() => {
    if (!query) return NO_MATCHES;
    return findMatches(segments.map((s) => s.text).join(""), query);
  }, [segments, query]);

  // Absolute start offset of each segment in the visible string, for mapping matches back to spans.
  const offsets = useMemo(() => {
    const out: number[] = [];
    let acc = 0;
    for (const s of segments) {
      out.push(acc);
      acc += s.text.length;
    }
    return out;
  }, [segments]);

  useEffect(() => {
    onMatchCount?.(matches.length);
  }, [matches, onMatchCount]);

  const currentRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (currentMatch < 0) return;
    currentRef.current?.scrollIntoView({ block: "center", behavior: "auto" });
  }, [currentMatch, matches]);

  const styleFor = (s: AnsiSegment): CSSProperties =>
    s.muted ? { ...s.style, color: "var(--border)", fontWeight: 400 } : s.style;

  if (matches.length === 0) {
    return (
      <pre className={preClass(wrap, className)} style={{ fontSize: `${fontSize}px` }}>
        {segments.map((s, i) => (
          <span key={i} style={styleFor(s)}>
            {s.text}
          </span>
        ))}
      </pre>
    );
  }

  // Ref only the first slice of the current match (a match can span segments on a colour change).
  let currentAssigned = false;
  return (
    <pre className={preClass(wrap, className)} style={{ fontSize: `${fontSize}px` }}>
      {segments.map((s, i) => {
        const pieces = splitSegment(s.text, offsets[i]!, matches);
        return (
          <span key={i} style={styleFor(s)}>
            {pieces.map((p, j) => {
              if (p.matchIndex === null) return p.text;
              const isCurrent = p.matchIndex === currentMatch;
              const attach = isCurrent && !currentAssigned;
              if (attach) currentAssigned = true;
              return (
                <span
                  key={j}
                  ref={attach ? currentRef : undefined}
                  data-find-match={isCurrent ? "current" : "other"}
                  className={cn(
                    "rounded-[2px]",
                    isCurrent ? "bg-yellow-400 text-black" : "bg-yellow-400/30",
                  )}
                >
                  {p.text}
                </span>
              );
            })}
          </span>
        );
      })}
    </pre>
  );
});
