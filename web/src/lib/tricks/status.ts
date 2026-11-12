// THE STATUS LINE'S OVERFLOW RULE (M94 re-cut, the `status` place), as one pure reading. The usage row
// (components/model-tag.tsx) draws Collie's own items first, then the tricks' status items in manifest
// order. When the line is wider than the room it has, the TRICKS give way first, the newest (the last in
// manifest order, the rightmost) before the older, and Collie's items never move: the model name only
// truncates once no trick item is left to hide. `ModelTag` measures; this decides.

export interface StatusFit {
  /** The room the line has, in px (the tag's max width less its own padding). */
  room: number;
  /** The natural width of Collie's own items together, in px. 0 when there are none. */
  own: number;
  /** The gap between two items, in px. */
  gap: number;
  /** The natural width of each trick item, in manifest order. */
  widths: readonly number[];
}

/**
 * How many of the trick items show, from the first. An item shows when it fits after everything before
 * it; the first one that does not fit hides itself and every later one, so a small item never jumps over
 * a large one that gave way. With no room for even the first, none show.
 */
export function visibleStatusCount({ room, own, gap, widths }: StatusFit): number {
  let used = own;
  for (let i = 0; i < widths.length; i++) {
    const next = used + (used > 0 ? gap : 0) + (widths[i] ?? 0);
    if (next > room) return i;
    used = next;
  }
  return widths.length;
}
