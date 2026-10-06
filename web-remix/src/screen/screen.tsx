// The terminal screen: a <pre> of keyed rows, each a <div> of styled <span>s. Port of the row
// drawing in web/src/components/ansi-output.tsx and raw-mirror.tsx, without React.
//
// Rows are keyed by content (screen/rows.ts), so when the terminal scrolls by a line Remix moves the
// row nodes instead of rewriting every row. Text goes in as text nodes, never as HTML.
//
// The mirror is drawn in DARK space under every theme and the light theme inverts it wholesale
// (ADR 0002, web/src/components/mirror-space.ts). The two class strings below are mirror-space.ts's
// MIRROR_SPACE and MIRROR_INVERT, spelled out here so Tailwind sees them in this project's sources.
import type { Handle, RemixNode } from "remix/component";

import { cn } from "@web/lib/utils";

import type { Row, Span } from "./rows";

export const MIRROR_SPACE = "[color-scheme:dark] bg-[#0a0a0a] text-[#fafafa]";
export const MIRROR_INVERT = "[filter:invert(1)_hue-rotate(180deg)] dark:[filter:none]";

function spanNode(span: Span): RemixNode {
  if (span.pieces === null) {
    return (
      <span style={span.style} class={span.class}>
        {span.text}
      </span>
    );
  }
  // A block or Powerline glyph is painted as a box (web/src/components/painted-cells.tsx): each
  // painted character is its own span carrying its shape as `data-cell`, styled by index.css.
  return (
    <span style={span.style} class={span.class}>
      {span.pieces.map((piece, i) =>
        piece.cell === undefined ? (
          piece.text
        ) : (
          <span key={String(i)} class="cell-glyph" data-cell={piece.cell}>
            {piece.text}
          </span>
        ),
      )}
    </span>
  );
}

export interface ScreenProps {
  rows: readonly Row[];
  /** Soft-wrap long rows at the phone's width (the mirror's default), or scroll them sideways. */
  wrap?: boolean;
  /** The mirror's font size in px (web's display pref default is 10). */
  fontSize?: number;
  /** Rounded inset variant, for the region a dialog card shows under its Terminal control. */
  inset?: boolean;
  testId?: string;
}

export function Screen(handle: Handle<ScreenProps>) {
  return () => {
    const { rows, wrap = true, fontSize = 10, inset = false, testId } = handle.props;
    return (
      <pre
        data-testid={testId}
        data-slot="screen"
        data-rows={rows.length}
        class={cn(
          "m-0 font-mono leading-[1.25] [font-variant-ligatures:none]",
          MIRROR_SPACE,
          MIRROR_INVERT,
          inset ? "overflow-x-auto rounded-lg px-2 py-1.5" : "min-h-full px-2 py-1.5",
          wrap ? "whitespace-pre-wrap break-words" : "overflow-x-auto whitespace-pre",
        )}
        style={{ fontSize: `${String(fontSize)}px` }}
      >
        {rows.map((row) => (
          <div key={row.key} class={cn("min-h-[1.25em]", row.noWrap && "overflow-hidden whitespace-pre")}>
            {row.spans.map(spanNode)}
          </div>
        ))}
      </pre>
    );
  };
}
