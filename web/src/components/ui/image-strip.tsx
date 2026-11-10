import type { ReactNode, Ref } from "react";

import { ImageSheet } from "@/components/ui/image-sheet";
import { OverflowEdges } from "@/components/ui/overflow-edges";
import { cn } from "@/lib/utils";

// PICTURES IN A ROW THAT SCROLLS SIDEWAYS (M96). Every picture at one height, each as wide as its own
// shape at that height, side by side; a row wider than the column scrolls and fades the edge that still
// hides one, with the house fade (`OverflowEdges`, the Belt's own, here with no chevron). A tap on a
// picture opens it at full size in the app's picture sheet (`ImageSheet`, the one Chat's pictures open).
// A Decision card's images.
//
// THE BOX IS RESERVED. Each item's width comes from the picture's known shape, never from its bytes, so
// an item draws the same box while it loads, once it has loaded and when it failed (`src` null and the
// caller's `fallback` in the box). Nothing moves when a picture lands (DESIGN.md §2).
//
// Owns no words and no loading: the caller names the row (`label`), hands each item its URL when it has
// one, and says what a failed item shows. `ref` reaches the outer box, not the scroller, so a caller can
// ask whether the ROW is near the screen (the scroller is its own scroll box, and an observer rooted
// there would call every picture in it visible).

/** The height of every picture in the strip, in px. `h-28` below is this number. */
export const IMAGE_STRIP_HEIGHT = 112;
/** The narrowest and widest an item gets, so a tall sliver or a panorama still reads as one picture. */
const MIN_WIDTH = 64;
const MAX_WIDTH = 280;

/** An item's width at the strip's height: the picture's own shape, clamped; square when the shape is unknown. */
export function stripItemWidth(width: number | null, height: number | null): number {
  if (width === null || height === null || width <= 0 || height <= 0) return IMAGE_STRIP_HEIGHT;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round((IMAGE_STRIP_HEIGHT * width) / height)));
}

export function ImageStrip({
  ref,
  label,
  className,
  scrollerClassName,
  children,
}: {
  ref?: Ref<HTMLDivElement>;
  /** Names the row for a screen reader. */
  label: string;
  /** The outer box: a negative margin, when the row runs to its container's edge. */
  className?: string;
  /** The scroller's padding, paired with that margin, so the first picture starts on the text's edge. */
  scrollerClassName?: string;
  /** `ImageStripItem`s. */
  children: ReactNode;
}) {
  return (
    <div ref={ref} role="group" aria-label={label} data-slot="image-strip" className={cn("flex min-w-0", className)}>
      <OverflowEdges cue="none">
        {(scroller) => (
          <div
            ref={scroller}
            className={cn(
              "flex min-w-0 flex-1 items-start gap-2 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
              scrollerClassName,
            )}
          >
            {children}
          </div>
        )}
      </OverflowEdges>
    </div>
  );
}

/** The picture's box: one height, the item's width, on a muted ground. The thumbnail fills it (cover); the sheet shows it whole. */
const BOX = "block h-28 w-full rounded-sm border border-border bg-muted";

export function ImageStripItem({
  width,
  height,
  src,
  alt,
  caption,
  fallback,
  onError,
}: {
  /** The picture's own size, when known: it sets the item's width before the bytes arrive. */
  width: number | null;
  height: number | null;
  /** The URL to draw, or null while it loads or after it failed. */
  src: string | null;
  /** The picture's words, for the image and for the sheet's title. */
  alt: string;
  /** A line under the picture. */
  caption?: string;
  /** What the box shows while `src` is null: nothing while it loads, the caller's words once it failed. */
  fallback?: ReactNode;
  onError?: () => void;
}) {
  return (
    <figure data-slot="image-strip-item" className="flex shrink-0 flex-col gap-1" style={{ width: stripItemWidth(width, height) }}>
      {src !== null ? (
        <ImageSheet src={src} alt={alt} title={alt} className="block w-full rounded-sm" imgClassName={cn(BOX, "object-cover")} onError={onError} />
      ) : (
        <span className={cn(BOX, "flex items-center justify-center overflow-hidden px-2")}>{fallback}</span>
      )}
      {caption !== undefined && <figcaption className="font-content truncate text-[11px] text-muted-foreground">{caption}</figcaption>}
    </figure>
  );
}
