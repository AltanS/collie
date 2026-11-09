import { cn } from "@/lib/utils";

// A SMALL RANGE OF THREE PEAKS, AS MANY OF THEM FILLED AS THE THING IS URGENT (M96). Three filled is
// the most, one the least. It reads without colour, the way a status mark does (DESIGN.md §3): the
// count of filled peaks is the first channel, the caller's ink the second. The Hill's priority (Now
// fills three, Today two, Later one) wears it on a Decision card and on the Hill's group headings.
//
// SHAPE ONLY. The ink is the caller's class (`currentColor`), and so is the size; the box is 18 x 12 px
// by default and every count fills the same box, so a change of level repaints and moves nothing (§2).
// A peak that is not filled is drawn as an outline filled with the surface under it (`surface`), so a
// higher peak in front of a filled one knocks it out cleanly instead of showing its lines through.
//
// NAMED OR NOT. With `label` the glyph is an image with that name; without one it is `aria-hidden`, for
// a caller that already says the level in words beside it.

/** How many of the three peaks are filled. */
export type PeakCount = 1 | 2 | 3;

/** Low to high, overlapping like a ridge. Drawn in this order, so a later peak paints over an earlier one. */
const PEAKS = ["M1 13 L5 7 L9 13 Z", "M5 13 L10 4 L15 13 Z", "M10 13 L15 1 L20 13 Z"] as const;

/** The fill of an empty peak: the surface the glyph stands on. Literal class strings, so Tailwind sees each. */
const SURFACE = {
  card: "fill-card",
  background: "fill-background",
} as const;

export function PeakGlyph({
  filled,
  label,
  surface = "card",
  className,
}: {
  filled: PeakCount;
  /** The glyph's name for a screen reader. Absent: decorative, the words beside it say the level. */
  label?: string;
  /** What the glyph stands on, so an empty peak is filled with it. */
  surface?: keyof typeof SURFACE;
  className?: string;
}) {
  const named = label !== undefined;
  return (
    <svg
      viewBox="0 0 21 14"
      role={named ? "img" : undefined}
      aria-label={label}
      aria-hidden={named ? undefined : true}
      data-slot="peak-glyph"
      data-filled={filled}
      className={cn("h-3 w-[18px] shrink-0", className)}
    >
      {PEAKS.map((d, i) => (
        <path
          key={d}
          d={d}
          data-peak={i < filled ? "filled" : "empty"}
          className={i < filled ? "fill-current" : SURFACE[surface]}
          stroke="currentColor"
          strokeWidth={1.4}
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}
