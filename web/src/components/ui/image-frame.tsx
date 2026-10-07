import type { ReactEventHandler } from "react";

import { cn } from "@/lib/utils";

// One picture shown whole, on a ground that shows its transparency, with one line under it.
//
// The Files view draws a picture file this way, a raster one from the bridge's bytes and an SVG from
// its own text (ADR 0090), and both are the same visual idea, so it is one primitive.
//
// THE GROUND IS A CHECKERBOARD, because a picture with transparent parts on a plain ground cannot be
// told apart from one painted that colour: a black logo on the dark theme vanishes. The squares are
// `--card` and `--muted`, the two nearest page tokens that differ in both themes (white and 0.94 in
// light, 0.205 and 0.269 in dark), so the board is quiet and still reads as a board. It is painted
// with a gradient, never an image file, so it costs no request and follows the theme for free.
//
// THE PICTURE FITS THE COLUMN and never the other way round: at most the column's width and 70% of
// the screen's height, scaled with its proportions kept, and centred. A small picture stays its own
// size, so a 16 px icon is not blown up into a blur. An animated GIF animates: it is a plain `<img>`.
//
// The caption is the caller's string, so it may be empty at first and filled once the picture has
// drawn (its natural size is known only then). The line is always there, so filling it moves nothing
// (DESIGN.md §2).

const CHECKERBOARD =
  "[background-image:conic-gradient(var(--muted)_0_25%,var(--card)_0_50%,var(--muted)_0_75%,var(--card)_0)] [background-size:16px_16px]";

export function ImageFrame({
  src,
  alt,
  caption,
  onLoad,
  onError,
  className,
}: {
  src: string;
  alt: string;
  caption: string;
  onLoad?: ReactEventHandler<HTMLImageElement>;
  onError?: ReactEventHandler<HTMLImageElement>;
  className?: string;
}) {
  return (
    <figure data-slot="image-frame" className={cn("flex flex-col gap-2", className)}>
      <div className={cn("flex justify-center overflow-hidden rounded-md border border-border", CHECKERBOARD)}>
        <img src={src} alt={alt} onLoad={onLoad} onError={onError} className="block h-auto max-h-[70dvh] w-auto max-w-full object-contain" />
      </div>
      <figcaption className="min-h-4 text-xs leading-4 text-muted-foreground tabular-nums">{caption}</figcaption>
    </figure>
  );
}
