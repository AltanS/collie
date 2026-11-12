import type { CSSProperties, ReactNode, Ref } from "react";

import { ImageSheet } from "@/components/ui/image-sheet";
import { OverflowEdges } from "@/components/ui/overflow-edges";
import { cn } from "@/lib/utils";

// PICTURES IN A ROW THAT SCROLLS SIDEWAYS (M96). Every picture of a row at one height, each as wide as
// its own shape at that height, side by side; a row wider than the column scrolls and fades the edge
// that still hides one, with the house fade (`OverflowEdges`, the Belt's own, here with no chevron). A
// tap on a picture opens it at full size in the app's picture sheet (`ImageSheet`, the one Chat's
// pictures open). A Decision card's images.
//
// ONE HEIGHT, CHOSEN FROM THE SHAPES (`stripSize`, 2026-11-10). A row of landscape or square pictures
// keeps the short height (112px), where a wide shot reads. A row where EVERY picture is portrait (a
// phone screenshot is 390 x 844) is tall: 240px, and never more than 45% of the screen's height, because
// a phone shot at 112px was a 52px sliver nobody could read. A single picture, any shape, is tall too
// and may use the whole width of the row up to that height.
//
// THE BOX IS RESERVED. Each item's box comes from the picture's known shape, never from its bytes, so an
// item draws the same box while it loads, once it has loaded and when it failed (`src` null and the
// caller's `fallback` in the box). Nothing moves when a picture lands (DESIGN.md §2). The sizes are CSS
// (`min()` against the screen's height, `clamp()` for the narrowest and widest item), so no measuring.
//
// A CAPTION READS. Up to two lines under its own picture, wrapped at word breaks; a third line is cut
// with an ellipsis and the whole caption is the line's `title`. An item with a caption is at least
// CAPTION_MIN_WIDTH wide, so a short caption under a narrow picture is not squeezed; the picture's box
// is the item's width, and the picture sits whole in it (contain) on the muted ground, so a phone shot
// in a short row is a framed tile and not a sliver with a gap beside it.
//
// Owns no words and no loading: the caller names the row (`label`), hands each item its URL when it has
// one, and says what a failed item shows. `ref` reaches the outer box, not the scroller, so a caller can
// ask whether the ROW is near the screen (the scroller is its own scroll box, and an observer rooted
// there would call every picture in it visible).

/** The short height of the strip, in px: a row with a landscape, square or unknown picture. */
export const IMAGE_STRIP_HEIGHT = 112;
/** The tall height, in px: a row of portrait pictures, or a single picture. */
export const IMAGE_STRIP_TALL = 240;
/** The most of the screen's height the tall strip takes, in percent. */
export const IMAGE_STRIP_TALL_VH = 45;
/** The narrowest an item with a caption gets, so the caption is not squeezed. */
export const CAPTION_MIN_WIDTH = 96;
/** The narrowest and widest an item of a row gets, so a tall sliver or a panorama still reads as one picture. */
const MIN_WIDTH = 64;
const MAX_WIDTH = 280;

/** A picture's own size, when the wire gave it. */
export interface PictureSize {
  width: number | null;
  height: number | null;
}

/** The strip's one height: short, or tall for portrait pictures and a single picture. */
export type StripSize = "short" | "tall";

function known(picture: PictureSize): picture is { width: number; height: number } {
  return picture.width !== null && picture.height !== null && picture.width > 0 && picture.height > 0;
}

/** Whether a picture is taller than it is wide. An unknown shape is not. */
export function isPortrait(picture: PictureSize): boolean {
  return known(picture) && picture.height > picture.width;
}

/** The height a row of these pictures takes: tall when there is one, or when every one is portrait. */
export function stripSize(pictures: readonly PictureSize[]): StripSize {
  if (pictures.length === 1) return "tall";
  return pictures.length > 0 && pictures.every(isPortrait) ? "tall" : "short";
}

/** The strip's height as CSS: a length, or the tall height held under its share of the screen. */
export function stripHeightCss(size: StripSize): string {
  return size === "short" ? `${IMAGE_STRIP_HEIGHT}px` : `min(${IMAGE_STRIP_TALL}px, ${IMAGE_STRIP_TALL_VH}dvh)`;
}

/** An item's width at the short height, in px: the picture's own shape, clamped; square when the shape is unknown. */
export function stripItemWidth(width: number | null, height: number | null): number {
  const picture = { width, height };
  if (!known(picture)) return IMAGE_STRIP_HEIGHT;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round((IMAGE_STRIP_HEIGHT * picture.width) / picture.height)));
}

/** How one item lays out, as CSS. The picture's box is as wide as the item. */
export interface StripItemCss {
  /** The item's width: the picture's at the strip's height, and at least CAPTION_MIN_WIDTH when it has a caption. */
  itemWidth: string;
  /** The picture's box height, or null when the item's width and the shape's ratio set it (a single picture). */
  boxHeight: string | null;
  /** The ratio a single picture keeps, as `w / h`. */
  ratio: string;
}

/**
 * The CSS sizes of one item. In a row: the strip's height, and the picture's width at that height,
 * clamped. A single picture: as wide as its shape at the tall height, never wider than the row, its
 * height from its ratio, so a wide shot uses the card's width and a phone shot stops at the tall height.
 */
export function stripItemCss({ picture, size, single, caption }: { picture: PictureSize; size: StripSize; single: boolean; caption: boolean }): StripItemCss {
  const height = stripHeightCss(size);
  const [w, h] = known(picture) ? [picture.width, picture.height] : [1, 1];
  const ratio = `${w} / ${h}`;
  let boxWidth: string;
  if (single) boxWidth = `min(calc(${height} * ${w} / ${h}), 100%)`;
  else if (size === "short") boxWidth = `${stripItemWidth(picture.width, picture.height)}px`;
  else boxWidth = `clamp(${MIN_WIDTH}px, calc(${height} * ${w} / ${h}), ${MAX_WIDTH}px)`;
  return { itemWidth: caption ? `max(${boxWidth}, ${CAPTION_MIN_WIDTH}px)` : boxWidth, boxHeight: single ? null : height, ratio };
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
              "flex min-w-0 flex-1 items-start gap-3 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
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

/** The picture's box on a muted ground. The thumbnail sits whole in it (contain); the sheet shows it at full size. */
const BOX = "block size-full rounded-sm border border-border bg-muted";

/** The custom properties an item's sizes ride on (a property holds any CSS math as it is). */
type ItemStyle = CSSProperties & { "--strip-item-w": string; "--strip-box-h"?: string; "--strip-ratio"?: string };

export function ImageStripItem({
  width,
  height,
  size = "short",
  single = false,
  src,
  alt,
  caption,
  fallback,
  onError,
}: {
  /** The picture's own size, when known: it sets the item's box before the bytes arrive. */
  width: number | null;
  height: number | null;
  /** The strip's one height for every item of the row (`stripSize`). */
  size?: StripSize;
  /** The row holds this picture alone: it may use the row's width. */
  single?: boolean;
  /** The URL to draw, or null while it loads or after it failed. */
  src: string | null;
  /** The picture's words, for the image and for the sheet's title. */
  alt: string;
  /** Up to two lines under the picture. */
  caption?: string;
  /** What the box shows while `src` is null: nothing while it loads, the caller's words once it failed. */
  fallback?: ReactNode;
  onError?: () => void;
}) {
  const css = stripItemCss({ picture: { width, height }, size, single, caption: caption !== undefined });
  const style: ItemStyle = { "--strip-item-w": css.itemWidth };
  if (css.boxHeight === null) style["--strip-ratio"] = css.ratio;
  else style["--strip-box-h"] = css.boxHeight;
  const box = cn("block w-full", css.boxHeight === null ? "aspect-[var(--strip-ratio)]" : "h-[var(--strip-box-h)]");
  return (
    <figure data-slot="image-strip-item" data-size={size} className="flex w-[var(--strip-item-w)] shrink-0 flex-col gap-1" style={style}>
      <span data-slot="image-strip-box" className={box}>
        {src !== null ? (
          <ImageSheet src={src} alt={alt} title={alt} className="block size-full rounded-sm" imgClassName={cn(BOX, "object-contain")} onError={onError} />
        ) : (
          <span className={cn(BOX, "flex items-center justify-center overflow-hidden px-2")}>{fallback}</span>
        )}
      </span>
      {caption !== undefined && (
        <figcaption title={caption} className="font-content line-clamp-2 text-[11px] leading-4 break-words text-muted-foreground">
          {caption}
        </figcaption>
      )}
    </figure>
  );
}
