// The background-agents block Claude paints under its statusline ("● main" plus one
// "◯ <agent>  <task>  <elapsed>" row per agent), re-surfaced as app chrome (issue #242). The strip
// above the composer peels it off the mirror with the input box, and until this element it had no
// surface at all.
//
// ITS OWN ELEMENT, not more rows in the statusline strip. The strip's 18dvh cap guards the mirror
// against an operator's script of any height; this block is Claude's own and bounded upstream
// (MAX_FOOTER_LINES in harness/claude/chrome.ts), so it does not share that budget.
//
// ONE ROW until tapped: the first agent's row, verbatim, with a `+N` for the rest. Tapping expands to
// every row as the pane painted it. Nothing here reads the content beyond one check: a first row led
// by "●" is the "main" header, so the collapsed row shows the agent under it instead. No new UI
// string, so no translation: the button's name is the agent row itself, and `aria-expanded` carries
// the state.

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { StyledLine } from "@/lib/blocks";
import { MIRROR_INVERT, MIRROR_SPACE, segmentStyle } from "@/components/mirror-space";
import type { MirrorFont } from "@/hooks/use-display-prefs";
import { cn } from "@/lib/utils";

function isHeader(row: StyledLine): boolean {
  return row.segments.map((s) => s.text).join("").trimStart().startsWith("●");
}

function Row({ row, className }: { row: StyledLine; className?: string }) {
  return (
    <div className={cn("truncate", className)}>
      {row.segments.map((s, si) => (
        // Text nodes only; colour and weight come from the ANSI parse. Same XSS boundary as the mirror.
        <span
          key={si}
          style={segmentStyle(s)}
          className={s.mobileTransparentBg ? "terminal-mobile-transparent-bg" : undefined}
        >
          {s.text}
        </span>
      ))}
    </div>
  );
}

export function AgentsFooter({ rows, face }: { rows: StyledLine[]; face: MirrorFont }) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;

  const agents = rows.length > 1 && isHeader(rows[0]!) ? rows.slice(1) : rows;
  const more = agents.length - 1;

  return (
    <div
      className={cn(
        "border-t border-border/40 px-3 py-1 font-mono text-[11px] leading-tight",
        // Terminal colour, so the mirror's dark space and its light-theme inversion (ADR 0002), as the
        // statusline strip does.
        MIRROR_SPACE,
        MIRROR_INVERT,
        face.className,
      )}
      style={face.style}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-2 text-left"
      >
        {open ? <Row row={rows[0]!} className="min-w-0 flex-1" /> : <Row row={agents[0]!} className="min-w-0 flex-1" />}
        {!open && more > 0 && <span className="shrink-0 text-[#a3a3a3]">+{more}</span>}
        <ChevronDown
          aria-hidden
          className={cn("size-3 shrink-0 text-[#a3a3a3] transition-transform", open && "rotate-180")}
        />
      </button>
      {open &&
        rows.slice(1).map((row, i) => (
          // Index key: a positional snapshot of the pane tail, re-derived on every poll.
          <Row key={i} row={row} />
        ))}
    </div>
  );
}
