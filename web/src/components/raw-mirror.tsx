import type { StyledLine } from "@/lib/blocks";
import { MIRROR_INVERT, MIRROR_SPACE, styleFor } from "@/components/mirror-space";
import { renderCells } from "@/components/painted-cells";
import { cn } from "@/lib/utils";

/**
 * The raw region a lifted card replaced, mirrored verbatim — the ONE implementation shared by
 * every card's terminal-mode toggle (ADR 0056) plus the two cards that used to inline this
 * themselves (the generic menu and the unread-dialog card). Same treatment as the pane mirror:
 * React text nodes only (the XSS boundary is unchanged — nothing is ever set as innerHTML), and
 * the agent's own terminal colours (MIRROR_SPACE / MIRROR_INVERT, ADR 0002). Scrolls horizontally
 * on its own so a wide screen never makes the page pan.
 *
 * `wrap` breaks long rows instead, anywhere, the way the pane mirror's Wrap does: the prompt card's
 * subject (a command, a diff, a warning) must be readable at phone width without a sideways pan.
 * `className` adds to the box, e.g. a height cap with its own vertical scroll.
 */
export function RawMirror({
  lines,
  wrap = false,
  className,
}: {
  lines: StyledLine[];
  wrap?: boolean;
  className?: string;
}) {
  return (
    <pre
      className={cn(
        "m-0 rounded-lg px-2 py-1.5 font-mono text-[11px] leading-[1.25]",
        wrap ? "whitespace-pre-wrap wrap-anywhere" : "overflow-x-auto whitespace-pre",
        MIRROR_SPACE,
        MIRROR_INVERT,
        className,
      )}
    >
      {lines.map((line, li) => (
        <span key={li}>
          {li > 0 ? "\n" : null}
          {line.segments.map((s, si) => (
            <span key={si} style={styleFor(s)}>
              {renderCells(s.text)}
            </span>
          ))}
        </span>
      ))}
    </pre>
  );
}
