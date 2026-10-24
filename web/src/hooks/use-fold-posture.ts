import { useKeyboardOpen } from "@/hooks/use-keyboard";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { WidthClass } from "@/lib/wide-layout";

/**
 * How a foldable is held, read from the Viewport Segments media features (ADR 0120, "Folded
 * postures"): two segments stacked top and bottom is TABLETOP (the fold runs across the screen), two
 * side by side is BOOK (the fold runs down the middle). Anything else, and every browser without the
 * feature (Safari, Firefox), is FLAT: an unknown media feature never matches, so they keep the width
 * layout untouched. Reactive: a hinge that moves re-renders.
 *
 * Device Posture alone is not read: `folded` says the hinge is bent, not where the fold runs across
 * the viewport, and the layout needs where.
 */
export type FoldPosture = "flat" | "tabletop" | "book";

export const TABLETOP_QUERY = "(vertical-viewport-segments: 2)";
export const BOOK_QUERY = "(horizontal-viewport-segments: 2)";

export function useFoldPosture(): FoldPosture {
  const tabletop = useMediaQuery(TABLETOP_QUERY);
  const book = useMediaQuery(BOOK_QUERY);
  if (tabletop) return "tabletop";
  return book ? "book" : "flat";
}

/**
 * The fold layout the pane screen draws: tabletop at every width, unless the soft keyboard is up,
 * because it covers the bottom half where the reply box would be; book only from 600px, where the
 * strip exists. Flat otherwise.
 */
export function usePaneFold(widthClass: WidthClass): FoldPosture {
  const posture = useFoldPosture();
  const keyboard = useKeyboardOpen();
  if (posture === "tabletop") return keyboard ? "flat" : "tabletop";
  if (posture === "book") return widthClass === "compact" ? "flat" : "book";
  return "flat";
}
