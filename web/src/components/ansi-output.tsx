import { memo, useMemo } from "react";

import { cn } from "@/lib/utils";
import { parseAnsi } from "@/lib/ansi";

export interface AnsiOutputProps {
  text: string;
  className?: string;
  /** false = no wrap; the block scrolls horizontally, preserving column alignment. Default true. */
  wrap?: boolean;
  /** Monospace font size in px. Default 11. */
  fontSize?: number;
}

// Faithful, colored mirror of a pane's recent terminal output. Text is always rendered as React
// text nodes (escaped); only color/weight come from the ANSI parse — no XSS surface.
//
// Performance: parseAnsi runs once per unique `text` value (useMemo), and React.memo prevents
// re-renders when props are unchanged — critical for the 1.5 s polling cadence on mobile.
// Segment style objects are pre-computed at parse time; the render map is allocation-free for
// non-muted segments and does one spread per muted segment (TUI rule/border lines only).
//
// No-wrap layout: when wrap=false the <pre> gets overflow-x:auto so it forms its own scroll
// container. The parent ChatMessageList carries overflow-x:hidden, which clips overflow at the
// panel boundary; the <pre>'s own scrollbar sits inside those bounds and works independently.
export const AnsiOutput = memo(function AnsiOutput({
  text,
  className,
  wrap = true,
  fontSize = 11,
}: AnsiOutputProps) {
  const segments = useMemo(() => parseAnsi(text), [text]);
  return (
    <pre
      className={cn(
        "m-0 font-mono leading-[1.35] text-foreground/90",
        wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre overflow-x-auto",
        className,
      )}
      style={{ fontSize: `${fontSize}px` }}
    >
      {segments.map((s, i) => (
        <span
          key={i}
          style={
            s.muted
              ? { ...s.style, color: "var(--border)", fontWeight: 400 }
              : s.style
          }
        >
          {s.text}
        </span>
      ))}
    </pre>
  );
});
