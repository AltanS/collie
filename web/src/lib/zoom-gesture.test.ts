import { describe, expect, it } from "vitest";

import {
  DOUBLE_TAP_MS,
  DOUBLE_TAP_SLOP,
  DOUBLE_TAP_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  clampScale,
  clampScroll,
  contentPointAt,
  doubleTapTarget,
  formatScale,
  isDoubleTap,
  pinchMove,
  pinchStart,
  stepScale,
  zoomAbout,
  type ZoomView,
} from "./zoom-gesture";

const rest: ZoomView = { scale: 1, scroll: { x: 0, y: 0 } };

describe("clampScale", () => {
  it("keeps a scale between 1× and 6×", () => {
    expect([0.2, 1, 2.5, 6, 9].map((s) => clampScale(s))).toEqual([MIN_ZOOM, 1, 2.5, MAX_ZOOM, MAX_ZOOM]);
  });

  it("answers the floor for a scale that is not a number at all", () => {
    expect(clampScale(Number.NaN)).toBe(MIN_ZOOM);
    expect(clampScale(Number.POSITIVE_INFINITY)).toBe(MIN_ZOOM);
  });
});

describe("zoomAbout: the content under the point stays under it", () => {
  it("anchors a zoom from rest on the given point", () => {
    const next = zoomAbout(rest, { x: 100, y: 50 }, 2);
    expect(next).toEqual({ scale: 2, scroll: { x: 100, y: 50 } });
    // The glyph that was at (100, 50) on screen is still there.
    expect(contentPointAt(next, { x: 100, y: 50 })).toEqual(contentPointAt(rest, { x: 100, y: 50 }));
  });

  it("anchors from an already zoomed, already scrolled view", () => {
    const from: ZoomView = { scale: 2, scroll: { x: 300, y: 1000 } };
    const at = { x: 40, y: 200 };
    const next = zoomAbout(from, at, 3);
    expect(next.scale).toBe(3);
    expect(contentPointAt(next, at)).toEqual(contentPointAt(from, at));
  });

  it("clamps the scale it is asked for, and anchors at the clamped one", () => {
    expect(zoomAbout(rest, { x: 10, y: 10 }, 40).scale).toBe(MAX_ZOOM);
    expect(zoomAbout({ scale: 2, scroll: { x: 0, y: 0 } }, { x: 0, y: 0 }, 0.1)).toEqual(rest);
  });
});

describe("clampScroll: the pan bounds", () => {
  const content = { width: 390, height: 2000 };
  const viewport = { width: 390, height: 700 };

  it("pans nowhere sideways at 1× when the text is as wide as the screen", () => {
    expect(clampScroll({ x: 50, y: 100 }, content, viewport, 1)).toEqual({ x: 0, y: 100 });
  });

  it("opens both axes once zoomed, up to the scaled box less the viewport", () => {
    expect(clampScroll({ x: 9999, y: 9999 }, content, viewport, 2)).toEqual({ x: 390, y: 3300 });
    expect(clampScroll({ x: -5, y: -5 }, content, viewport, 2)).toEqual({ x: 0, y: 0 });
  });

  it("scrolls nowhere when the scaled text is smaller than the viewport", () => {
    expect(clampScroll({ x: 10, y: 10 }, { width: 100, height: 100 }, viewport, 2)).toEqual({ x: 0, y: 0 });
  });

  it("follows the unwrapped text's real width: a row wider than the screen pans to its end, at 1× and zoomed", () => {
    const wide = { width: 1200, height: 2000 };
    expect(clampScroll({ x: 9999, y: 0 }, wide, viewport, 1)).toEqual({ x: 810, y: 0 });
    expect(clampScroll({ x: 9999, y: 0 }, wide, viewport, 3)).toEqual({ x: 3210, y: 0 });
    // A pinch about a point on that wide row still lands it under the fingers, inside the bounds.
    const from: ZoomView = { scale: 1, scroll: { x: 600, y: 0 } };
    const next = zoomAbout(from, { x: 200, y: 300 }, 2);
    expect(contentPointAt(next, { x: 200, y: 300 })).toEqual(contentPointAt(from, { x: 200, y: 300 }));
    expect(clampScroll(next.scroll, wide, viewport, next.scale)).toEqual(next.scroll);
  });
});

describe("pinch", () => {
  it("scales by the ratio of the spread and keeps the midpoint's content between the fingers", () => {
    const start = pinchStart(rest, { x: 100, y: 300 }, { x: 200, y: 300 });
    expect(start.distance).toBe(100);
    expect(start.anchor).toEqual({ x: 150, y: 300 });
    const next = pinchMove(start, { x: 50, y: 300 }, { x: 250, y: 300 });
    expect(next.scale).toBe(2);
    expect(contentPointAt(next, { x: 150, y: 300 })).toEqual(start.anchor);
  });

  it("pans with the fingers when both move together", () => {
    const start = pinchStart(rest, { x: 100, y: 300 }, { x: 200, y: 300 });
    const next = pinchMove(start, { x: 80, y: 260 }, { x: 180, y: 260 });
    expect(next.scale).toBe(1);
    expect(contentPointAt(next, { x: 130, y: 260 })).toEqual(start.anchor);
  });

  it("stops at the bounds of the range", () => {
    const start = pinchStart(rest, { x: 100, y: 0 }, { x: 110, y: 0 });
    expect(pinchMove(start, { x: 0, y: 0 }, { x: 400, y: 0 }).scale).toBe(MAX_ZOOM);
    expect(pinchMove(start, { x: 104, y: 0 }, { x: 105, y: 0 }).scale).toBe(MIN_ZOOM);
  });

  it("holds the scale for two fingers that landed on one point", () => {
    const start = pinchStart({ scale: 3, scroll: { x: 0, y: 0 } }, { x: 10, y: 10 }, { x: 10, y: 10 });
    expect(pinchMove(start, { x: 0, y: 0 }, { x: 50, y: 50 }).scale).toBe(3);
  });
});

describe("double tap", () => {
  const tap = (at: number, x = 100, y = 100) => ({ at, point: { x, y } });

  it("is two taps close in time and on the glass", () => {
    expect(isDoubleTap(tap(0), tap(DOUBLE_TAP_MS))).toBe(true);
    expect(isDoubleTap(tap(0), tap(DOUBLE_TAP_MS + 1))).toBe(false);
    expect(isDoubleTap(tap(0), tap(100, 100 + DOUBLE_TAP_SLOP + 1))).toBe(false);
    expect(isDoubleTap(null, tap(0))).toBe(false);
    expect(isDoubleTap(tap(500), tap(400))).toBe(false);
  });

  it("toggles: rest zooms to 2.5×, anything zoomed goes back to 1×", () => {
    expect(doubleTapTarget(1)).toBe(DOUBLE_TAP_ZOOM);
    expect(doubleTapTarget(DOUBLE_TAP_ZOOM)).toBe(MIN_ZOOM);
    expect(doubleTapTarget(1.2)).toBe(MIN_ZOOM);
  });
});

describe("steps and the readout", () => {
  it("steps by 1.5× inside the range", () => {
    expect(stepScale(1, 1)).toBe(1.5);
    expect(stepScale(1.5, -1)).toBe(1);
    expect(stepScale(1, -1)).toBe(MIN_ZOOM);
    expect(stepScale(5, 1)).toBe(MAX_ZOOM);
  });

  it("prints at most one decimal", () => {
    expect([1, 1.5, 2.25, 6].map(formatScale)).toEqual(["1×", "1.5×", "2.3×", "6×"]);
  });
});
