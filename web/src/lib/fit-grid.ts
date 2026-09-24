// ── HOW MANY TERMINAL CELLS THIS PHONE'S MIRROR CAN SHOW ─────────────────────────────────────────
//
// "Fit to phone" (ADR 0049) asks the bridge to size a pane's PTY to what the phone can actually
// display. Nothing else in web/src measures a character cell, and the reason is worth keeping: the
// mirror renders Herdr's already-laid-out grid as text (ADR 0008), so it never NEEDS to know a cell's
// width. This feature is the one question that does, and it is answered once, here, from two numbers
// the browser measures for us:
//
//   • the mirror's CONTENT box — the scroller's client box minus its own padding, which is exactly
//     the area a `<pre>` line can occupy without panning; and
//   • one CELL — a hidden probe run of `FIT_PROBE_TEXT` set in the mirror's own font, size, line
//     height, tracking and ligature setting. Width over character count is one advance; the probe's
//     box height is one line (the mirror's `leading-[1.25]`).
//
// A run of several glyphs, not one: a single advance measured by layout carries the sub-pixel
// rounding of one box, and a narrow monospace face at 9px would then over-count by a column on a
// wide phone. Twenty glyphs average it away.
//
// `floor`, never `round`: a column the mirror cannot fully show is a column the TUI will draw into
// and the phone will wrap, which is the whole failure being fixed.
//
// The math is pure (and tested with injected numbers, because jsdom has no layout). The DOM read
// beside it is the only impure line, and it answers `null` wherever layout is absent — jsdom, a
// detached element, a view that has not painted — so a caller never leases a 0×0 terminal.

/** The bridge's bounds, mirrored from `FIT_BOUNDS` in bridge/fit-leases.ts (ADR 0049). */
export const FIT_BOUNDS = { minCols: 20, maxCols: 500, minRows: 8, maxRows: 300 } as const;

/** The probe run. Any glyph works in a monospace face; `M` is the one a proportional fallback
 *  would draw WIDEST, so a mis-resolved font under-counts columns rather than over-counting them. */
export const FIT_PROBE_TEXT = "M".repeat(20);

/** A terminal size, in whole cells. */
export interface FitSize {
  readonly cols: number;
  readonly rows: number;
}

/** What the browser measured, in CSS pixels. */
export interface MirrorMetrics {
  /** The mirror's content box: the scroller's client width minus its horizontal padding. */
  readonly contentWidth: number;
  /** The mirror's visible height: the scroller's client height minus its vertical padding. */
  readonly contentHeight: number;
  /** The probe run's rendered width. */
  readonly probeWidth: number;
  /** How many glyphs the probe run holds. */
  readonly probeChars: number;
  /** One line box of the mirror's text. */
  readonly lineHeight: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

function positive(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

/**
 * The grid the measured mirror can show, before the bridge's bounds — or `null` when the numbers
 * describe no layout at all (a zero or non-finite measurement).
 */
export function fitGrid(m: MirrorMetrics): FitSize | null {
  if (!positive(m.contentWidth) || !positive(m.contentHeight)) return null;
  if (!positive(m.probeWidth) || !positive(m.lineHeight) || !positive(m.probeChars)) return null;
  const cell = m.probeWidth / m.probeChars;
  return { cols: Math.floor(m.contentWidth / cell), rows: Math.floor(m.contentHeight / m.lineHeight) };
}

/**
 * A size forced inside the bridge's bounds. The phone clamps before sending rather than letting the
 * bridge refuse, because every value outside them has a sensible nearest one: a mirror narrower than
 * twenty columns is still better served by twenty than by an error.
 */
export function clampFitSize(size: FitSize): FitSize {
  return {
    cols: clamp(size.cols, FIT_BOUNDS.minCols, FIT_BOUNDS.maxCols),
    rows: clamp(size.rows, FIT_BOUNDS.minRows, FIT_BOUNDS.maxRows),
  };
}

/** Whether two sizes name the same grid. */
export function sameFitSize(a: FitSize, b: FitSize): boolean {
  return a.cols === b.cols && a.rows === b.rows;
}

function px(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Measure the mirror now: the scroller's content box against the probe run, clamped to the bounds.
 * `null` where there is no layout to measure (see the header).
 */
export function measureMirrorGrid(scroller: HTMLElement, probe: HTMLElement): FitSize | null {
  const style = getComputedStyle(scroller);
  const box = probe.getBoundingClientRect();
  const grid = fitGrid({
    contentWidth: scroller.clientWidth - px(style.paddingLeft) - px(style.paddingRight),
    contentHeight: scroller.clientHeight - px(style.paddingTop) - px(style.paddingBottom),
    probeWidth: box.width,
    probeChars: probe.textContent?.length ?? 0,
    lineHeight: box.height,
  });
  return grid === null ? null : clampFitSize(grid);
}
