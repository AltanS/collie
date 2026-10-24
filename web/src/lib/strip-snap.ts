// The strip's niri-style snapping, as pure arithmetic. Positions are scroll coordinates (a column's
// `offsetLeft`), widths are px. No DOM here: `hooks/use-strip-snap.ts` reads the DOM and calls this.

/** The strip scrolls and snaps on a pointer wheel or a touch fling; CSS does the touch half. */
export const STRIP_SNAP_CLASSES = "snap-x snap-mandatory overscroll-x-contain";
/** Every column is a snap point at its left edge. Stopping at each one is the browser default. */
export const COLUMN_SNAP_CLASSES = "snap-start [scroll-snap-stop:normal]";

// Sub-pixel slack. scrollLeft and offsetLeft are rounded differently, so a column that sits exactly
// at an edge can measure a fraction of a pixel outside it. That still counts as inside.
const EDGE_EPSILON_PX = 1;

export interface Viewport {
  left: number;
  width: number;
}

export interface ColumnBox {
  start: number;
  width: number;
}

/** The start to settle on: the nearest one, and on an exact tie the left one. */
export function nearestColumnStart(scrollLeft: number, columnStarts: readonly number[]): number {
  let best: number | undefined;
  for (const start of columnStarts) {
    if (best === undefined) {
      best = start;
      continue;
    }
    const gap = Math.abs(start - scrollLeft);
    const bestGap = Math.abs(best - scrollLeft);
    if (gap < bestGap || (gap === bestGap && start < best)) best = start;
  }
  return best ?? scrollLeft;
}

// Whole inside the viewport, edges included. A column wider than the viewport can never be whole,
// so one that covers the viewport edge to edge counts: it is as visible as it can be.
function isWhole(viewport: Viewport, column: ColumnBox): boolean {
  const right = viewport.left + viewport.width;
  const end = column.start + column.width;
  if (column.start >= viewport.left - EDGE_EPSILON_PX && end <= right + EDGE_EPSILON_PX) return true;
  if (column.width < viewport.width) return false;
  return column.start <= viewport.left + EDGE_EPSILON_PX && end >= right - EDGE_EPSILON_PX;
}

/** True only once the focused column is no longer fully visible: only then does focus have to move. */
export function shouldFollowFocus(viewport: Viewport, focusedColumn: ColumnBox): boolean {
  return !isWhole(viewport, focusedColumn);
}

/** The leftmost column that is fully visible, which a focus that scrolled out of view moves to. */
export function leftmostWholeColumn<K>(viewport: Viewport, columns: readonly (ColumnBox & { key: K })[]): K | undefined {
  let best: (ColumnBox & { key: K }) | undefined;
  for (const column of columns) {
    if (!isWhole(viewport, column)) continue;
    if (best === undefined || column.start < best.start) best = column;
  }
  return best?.key;
}
