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
/** A native mirror (Muse, ADR 0047) is drawn in the theme's own light space and never inverted. */
export const MUSE_MIRROR = "terminal-muse bg-[#fffbf8] text-[#0a0a0a] dark:bg-[#0a0a0a] dark:text-[#fafafa]";

/** web/src/components/ansi-output.tsx LINK_CLASS. */
const LINK_CLASS = "underline decoration-1 underline-offset-2 break-all cursor-pointer py-[0.35em]";

/**
 * A find hit. The current one re-applies the mirror filter to cancel it, so its yellow survives the
 * light theme's inversion; a native mirror inverts nothing, so it takes the yellow as is. The other
 * hits set no ink and take the plain inversion (ADR 0002, ansi-output.tsx says why).
 */
function markClass(mark: "current" | "other", native: boolean): string {
  if (mark === "other") return "rounded-md bg-yellow-400/30";
  return cn("rounded-md bg-yellow-400 text-black", native ? null : MIRROR_INVERT);
}

function spanNode(span: Span, native: boolean): RemixNode {
  const inner = paintedNode(span);
  const marked =
    span.mark === undefined ? (
      inner
    ) : (
      <span data-find-match={span.mark} class={markClass(span.mark, native)}>
        {inner}
      </span>
    );
  if (span.href === undefined) return marked;
  return (
    <a href={span.href} target="_blank" rel="noopener noreferrer" class={LINK_CLASS}>
      {marked}
    </a>
  );
}

function paintedNode(span: Span): RemixNode {
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
  /** Muse's native mirror (ADR 0047): light space, no inversion. */
  native?: boolean;
  /** The chosen terminal face (web's `mirrorFont`): a class and a font stack. */
  faceClass?: string;
  faceFamily?: string;
}

export function Screen(handle: Handle<ScreenProps>) {
  return () => {
    const { rows, wrap = true, fontSize = 10, inset = false, testId, native = false, faceClass, faceFamily } = handle.props;
    return (
      <pre
        data-testid={testId}
        data-slot="screen"
        data-rows={rows.length}
        class={cn(
          "m-0 font-mono leading-[1.25] [font-variant-ligatures:none]",
          native ? MUSE_MIRROR : MIRROR_SPACE,
          native ? null : MIRROR_INVERT,
          faceClass,
          inset ? "overflow-x-auto rounded-lg px-2 py-1.5" : "min-h-full px-2 py-1.5",
          wrap ? "whitespace-pre-wrap break-words" : "overflow-x-auto whitespace-pre",
        )}
        style={faceFamily === undefined ? { fontSize: `${String(fontSize)}px` } : { fontSize: `${String(fontSize)}px`, fontFamily: faceFamily }}
      >
        {rows.map((row) => (
          <div key={row.key} class={cn("min-h-[1.25em]", row.noWrap && "overflow-hidden whitespace-pre")}>
            {row.spans.map((span) => spanNode(span, native))}
          </div>
        ))}
      </pre>
    );
  };
}
