// THE ZOOMED OUTPUT'S GESTURE MATH, pure, so every rule the fingers meet is a table test and not a
// guess about touch events (components/output-zoom.tsx is the one caller).
//
// The view is a native scroller over a sized box: the text is laid out ONCE at the phone's width,
// drawn scaled by a transform, and the box around it is the scaled size, so the browser's own scroll
// does every one-finger pan, momentum included, and bounds it. Zoom is then two numbers, the scale
// and the scroll offset, and every gesture below is a function from the old pair to the new one.
//
// Coordinates: a VIEWPORT point is relative to the scroller's top-left corner as drawn (what a
// finger touches, minus the scroller's rect). A CONTENT point is in the unscaled text's own px, so
// the same glyph has the same content point at every scale. `viewport = content × scale − scroll`.

/** The view opens at, and never goes below, the text as the mirror lays it out. */
export const MIN_ZOOM = 1;
/** Six times the mirror's size: an 11px row reads at 66px, far past what a phone needs. */
export const MAX_ZOOM = 6;
/** Where a double tap at rest lands: big enough to read 11px text, small enough to keep a line in view. */
export const DOUBLE_TAP_ZOOM = 2.5;
/** One tap of the zoom-in or zoom-out button. */
export const ZOOM_STEP = 1.5;
/** Two taps this close in time count as one double tap. */
export const DOUBLE_TAP_MS = 300;
/** And this close on the glass, in CSS px. */
export const DOUBLE_TAP_SLOP = 30;
/** A touch that moved further than this is a pan, never a tap. */
export const TAP_SLOP = 10;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** The whole state a gesture moves: how big, and which part of the scaled box is on screen. */
export interface ZoomView {
  readonly scale: number;
  readonly scroll: Point;
}

/** A scale inside the view's range. A non-finite input (a zero-distance pinch) answers the floor. */
export function clampScale(scale: number, min = MIN_ZOOM, max = MAX_ZOOM): number {
  if (!Number.isFinite(scale)) return min;
  return Math.min(max, Math.max(min, scale));
}

/**
 * The scroll offset clamped to what the scaled box can show: 0 at the start of each axis, and at the
 * end the box's scaled size less the viewport's. A box smaller than the viewport scrolls nowhere.
 */
export function clampScroll(scroll: Point, content: Size, viewport: Size, scale: number): Point {
  const maxX = Math.max(0, content.width * scale - viewport.width);
  const maxY = Math.max(0, content.height * scale - viewport.height);
  return {
    x: Math.min(maxX, Math.max(0, scroll.x)),
    y: Math.min(maxY, Math.max(0, scroll.y)),
  };
}

/** The unscaled content point under a viewport point. */
export function contentPointAt(view: ZoomView, at: Point): Point {
  return { x: (view.scroll.x + at.x) / view.scale, y: (view.scroll.y + at.y) / view.scale };
}

/**
 * Zoom to `nextScale` (clamped) keeping the content under `at` exactly where it is on screen — the
 * one rule that makes a pinch feel anchored between the fingers. Not clamped to the box: the caller
 * clamps once, against the box it actually has, after the scale is applied.
 */
export function zoomAbout(view: ZoomView, at: Point, nextScale: number): ZoomView {
  const scale = clampScale(nextScale);
  const anchor = contentPointAt(view, at);
  return { scale, scroll: { x: anchor.x * scale - at.x, y: anchor.y * scale - at.y } };
}

/** Distance between two touches, in CSS px. */
export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** The point halfway between two touches. */
export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** What a pinch remembers from the moment its second finger landed. */
export interface PinchStart {
  /** The scale then. */
  readonly scale: number;
  /** The fingers' distance then. */
  readonly distance: number;
  /** The unscaled content point under the fingers' midpoint then: the pinch's anchor. */
  readonly anchor: Point;
}

/** Begin a pinch: remember the scale, the spread and the content between the fingers. */
export function pinchStart(view: ZoomView, a: Point, b: Point): PinchStart {
  return { scale: view.scale, distance: distance(a, b), anchor: contentPointAt(view, midpoint(a, b)) };
}

/**
 * One move of a pinch. The scale follows the ratio of the spread to the spread it started with, and
 * the anchor stays under the fingers' CURRENT midpoint, so moving both fingers together pans too.
 */
export function pinchMove(start: PinchStart, a: Point, b: Point): ZoomView {
  const ratio = start.distance > 0 ? distance(a, b) / start.distance : 1;
  const scale = clampScale(start.scale * ratio);
  const mid = midpoint(a, b);
  return { scale, scroll: { x: start.anchor.x * scale - mid.x, y: start.anchor.y * scale - mid.y } };
}

/** A tap, as the double-tap test needs it: when and where it landed. */
export interface Tap {
  readonly at: number;
  readonly point: Point;
}

/** Whether `next` completes a double tap begun by `prev`: close enough in time and on the glass. */
export function isDoubleTap(prev: Tap | null, next: Tap): boolean {
  if (prev === null) return false;
  const dt = next.at - prev.at;
  return dt >= 0 && dt <= DOUBLE_TAP_MS && distance(prev.point, next.point) <= DOUBLE_TAP_SLOP;
}

/**
 * The double tap's toggle: zoomed in at all, it goes back to the mirror's size; at rest, it zooms to
 * {@link DOUBLE_TAP_ZOOM}. Either way about the tapped point, so the line under the thumb stays put.
 */
export function doubleTapTarget(scale: number): number {
  return scale > MIN_ZOOM + 0.01 ? MIN_ZOOM : DOUBLE_TAP_ZOOM;
}

/** The scale one button step away, `direction` 1 in and −1 out, clamped. */
export function stepScale(scale: number, direction: 1 | -1): number {
  return clampScale(direction === 1 ? scale * ZOOM_STEP : scale / ZOOM_STEP);
}

/** The scale as the header prints it: `1×`, `2.5×`, `6×`. One decimal at most. */
export function formatScale(scale: number): string {
  return `${Math.round(scale * 10) / 10}×`;
}
