import type { ReactNode } from "react";

import { OverflowEdges } from "@/components/ui/overflow-edges";
import { cn } from "@/lib/utils";

// ROUND TILES IN A ROW THAT SCROLLS SIDEWAYS (2026-11-10, the `dashboard` place of tricks). Each tile is
// a round face with an icon, the short name under it, and an optional quiet badge on the face's corner.
// A row wider than the column scrolls and fades the edge that still hides a tile, with the house fade
// (`OverflowEdges`, no chevron, as the Belt and `ui/image-strip.tsx` have it), and no scrollbar.
//
// EVERY TILE IS THE SAME BOX. 60px wide, the 48px face, one truncated 16px line under it: 72px tall with
// its padding, so a long name, a badge arriving or leaving, or a tone change moves nothing (DESIGN.md §2).
// The face is full round because it is as wide as it is tall (§3). Never a status shape: the face
// carries the caller's icon in the caller's ink, and the badge is outlined, never the red count.
//
// Owns no words and no data: the caller names the row (`label`) and each tile, and says whether a tile
// takes a tap. A tile with no tap is a span, drawn the same, and no control at all.

export function TileStrip({
  label,
  className,
  children,
}: {
  /** Names the row for a screen reader. */
  label: string;
  /** The outer box. */
  className?: string;
  /** `TileStripItem`s. */
  children: ReactNode;
}) {
  return (
    <div role="group" aria-label={label} data-slot="tile-strip" className={cn("flex min-w-0", className)}>
      <OverflowEdges cue="none">
        {(scroller) => (
          <div
            ref={scroller}
            data-slot="tile-strip-scroller"
            // The row runs to the column's edges and starts its first tile on the page gutter.
            className="flex min-w-0 flex-1 items-start gap-1.5 overflow-x-auto overscroll-x-contain px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {children}
          </div>
        )}
      </OverflowEdges>
    </div>
  );
}

export interface TileStripItemProps {
  label: string;
  /** The face's glyph, already inked by the caller. */
  icon: ReactNode;
  /** A quiet outlined count or short word on the face's corner. 0 draws none. */
  badge?: number | string;
  /** ALREADY TRANSLATED. The tile's whole name for a screen reader. */
  name: string;
  /** The tap. Absent: the tile is drawn, inert, and takes no tap. */
  onSelect?: () => void;
  /** Data attributes for the caller's own handle (`data-trick`). */
  data?: Readonly<Record<`data-${string}`, string | undefined>>;
}

/** The tile's box: 60px wide, 72px tall, a 44px floor met in both directions (§6). */
const TILE = "group flex w-[60px] shrink-0 touch-manipulation flex-col items-center gap-1 rounded-sm py-1";

export function TileStripItem({ label, icon, badge, name, onSelect, data }: TileStripItemProps) {
  const shown = badge === undefined || badge === 0 ? undefined : String(badge);
  const face = (
    <>
      <span
        aria-hidden
        data-slot="tile-face"
        className={cn(
          "relative flex size-12 items-center justify-center rounded-full border border-border bg-card shadow-xs",
          onSelect !== undefined && "transition-transform group-active:scale-95 motion-reduce:transition-none",
        )}
      >
        {icon}
        {shown !== undefined && (
          <span
            data-slot="tile-badge"
            className="absolute -top-1 -right-1 flex h-[18px] max-w-14 min-w-[18px] items-center justify-center rounded-sm border border-border bg-card px-1 text-[10px] leading-none font-semibold text-foreground tabular-nums"
          >
            <span className="truncate">{shown}</span>
          </span>
        )}
      </span>
      <span aria-hidden className="w-full truncate text-center text-[11px] leading-4 text-foreground">
        {label}
      </span>
    </>
  );
  if (onSelect === undefined) {
    return (
      <span data-slot="tile" {...data} className={TILE}>
        <span className="sr-only">{name}</span>
        {face}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-slot="tile"
      {...data}
      aria-label={name}
      onClick={onSelect}
      className={cn(TILE, "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring")}
    >
      {face}
    </button>
  );
}
