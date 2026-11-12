import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/utils";

// A PICTURE IN A FRAME, CROPPED BY CSS ALONE (2026-11-10). A poster who wants the reader to look at one
// corner of a screenshot names a point and a zoom (`focus` on a Decision view's `image`), and the phone
// crops the picture itself: no image tool on the poster's side, no second file on the bridge.
//
// THE CROP. `object-position` puts the point of the picture at the same point of the frame (50% of the
// picture on 50% of the frame, 80% on 80%), and a zoom scales the picture about that point. So the point
// stays in view at every zoom, and with `cover` no edge of the frame ever shows the ground behind it.
// `contain` (the default) shows the whole picture on the muted ground; `cover` fills the frame and cuts
// the edges.
//
// THE FRAME IS RESERVED. Its box comes from the caller's ratio, never from the bytes, so it draws the same
// box while the picture loads, once it has loaded and after it failed (`children` in place of the
// picture). With `onOpen` the frame is one button that opens the picture at full size; without, it is
// a plain box.

/** How a picture fills its frame. */
export type FocusFit = "contain" | "cover";

/** The point to keep in view, in percent across and down the picture, and how far to zoom in on it. */
export interface FocusCrop {
  x: number;
  y: number;
  zoom: number;
}

/** The CSS that crops a picture: its fit, the point on the frame's same point, and the zoom about it. */
export function focusStyle(fit: FocusFit, crop?: FocusCrop): CSSProperties {
  const at = crop === undefined ? "50% 50%" : `${String(crop.x)}% ${String(crop.y)}%`;
  const style: CSSProperties = { objectFit: fit, objectPosition: at };
  if (crop !== undefined && crop.zoom > 1) {
    style.transform = `scale(${String(crop.zoom)})`;
    style.transformOrigin = at;
  }
  return style;
}

/** The picture itself, filling its frame, cropped by `fit` and `crop`. */
export function FocusImage({ src, alt, fit = "contain", crop, onError }: { src: string; alt: string; fit?: FocusFit; crop?: FocusCrop; onError?: () => void }) {
  return <img src={src} alt={alt} loading="lazy" decoding="async" onError={onError} style={focusStyle(fit, crop)} className="block size-full" />;
}

/**
 * The frame around a picture: a thin border, the muted ground, the house corner, and its box from
 * `ratio` (`"600 / 360"`), held under `maxHeight` when one is given. `onOpen` makes it a button named by
 * `label`; the picture or the caller's stand-in goes in `children`.
 */
export function FocusFrame({
  ratio,
  maxHeight,
  label,
  onOpen,
  className,
  style,
  children,
}: {
  ratio: string;
  maxHeight?: string;
  label?: string;
  onOpen?: () => void;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const box: CSSProperties = { aspectRatio: ratio, ...style };
  if (maxHeight !== undefined) box.maxHeight = maxHeight;
  const frame = cn("relative flex w-full min-w-0 items-center justify-center overflow-hidden rounded-sm border border-border bg-muted", className);
  if (onOpen === undefined) {
    return (
      <span data-slot="focus-frame" style={box} className={frame}>
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-slot="focus-frame"
      aria-label={label}
      title={label}
      onClick={onOpen}
      style={box}
      className={cn(frame, "cursor-zoom-in focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring")}
    >
      {children}
    </button>
  );
}
