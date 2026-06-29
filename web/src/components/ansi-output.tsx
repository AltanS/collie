import { useMemo } from "react";
import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";
import { parseAnsi, type AnsiSegment } from "@/lib/ansi";

function styleOf(s: AnsiSegment): CSSProperties {
  const st: CSSProperties = {};
  if (s.fg) st.color = s.fg;
  if (s.bg) st.backgroundColor = s.bg;
  if (s.bold) st.fontWeight = 600;
  if (s.italic) st.fontStyle = "italic";
  if (s.dim) st.opacity = 0.6;
  const deco = [s.underline ? "underline" : "", s.strike ? "line-through" : ""]
    .filter(Boolean)
    .join(" ");
  if (deco) st.textDecoration = deco;
  return st;
}

// A segment that's nothing but box-drawing / horizontal-rule glyphs (ignoring spaces) — i.e. a TUI
// border or separator, not real content. Agents (Claude, etc.) draw these full-terminal-width in a
// loud theme color; on a narrow phone they wrap and stack into noisy bars. We mute them to a faint
// divider so they read as structure, not noise. Conservative on purpose: only Unicode box-drawing
// and dashes count (not ASCII `-`/`=`), so code and markdown rules in real output stay untouched.
const RULE_GLYPHS = /^[─-╿‒-―]+$/;
function isRuleSegment(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  return compact.length >= 2 && RULE_GLYPHS.test(compact);
}

// Faithful, colored mirror of a pane's recent terminal output. Text is always rendered as React
// text nodes (escaped); only color/weight come from the ANSI parse — no XSS surface.
export function AnsiOutput({ text, className }: { text: string; className?: string }) {
  const segments = useMemo(() => parseAnsi(text), [text]);
  return (
    <pre
      className={cn(
        "m-0 whitespace-pre-wrap break-words font-mono text-[11px] leading-[1.35] text-foreground/90",
        className,
      )}
    >
      {segments.map((s, i) => {
        const style = styleOf(s);
        if (isRuleSegment(s.text)) {
          style.color = "var(--border)";
          style.fontWeight = 400;
        }
        return (
          <span key={i} style={style}>
            {s.text}
          </span>
        );
      })}
    </pre>
  );
}
