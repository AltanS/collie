import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

// FLIP (First, Last, Invert, Play) for the composer box's two shapes (`layout="box"`), and the way a
// button enters in either layout. The box changes shape by moving its buttons between grid cells, so
// the change is instant by default. This hook records where the box and its buttons stood, lets the
// new layout land, then plays the way from the old shape to the new one with the Web Animations API.
//
// THE BUTTONS MOVE ON THE X-AXIS ONLY, AND NOTHING DROPS (Altan, 2026-11-07: "it looks like they
// bounce down from the top"). The first version played each button from its old cell to its new one
// in the box's own frame. That was meant to hold the button row still while the box grew, but the
// box's height is animated on the grid itself, and a grid squeezed below its content shrinks the
// field's row first (a scrolling textarea has no automatic minimum height). So the button row was
// laid out ~20px too high when the flight began and fell to its place as the height grew: a drop of
// about 21px on the pane screen and 50px where the box grows downward, measured in Chromium.
//
// So now, for the length of the flight, the grid keeps the new shape's own row heights and stands
// them against the edge of the box that does not move (`anchorEdge`): the bottom on the pane screen,
// where the composer is anchored to the screen's foot, the top where the box grows downward. The
// moving edge then only uncovers or covers what already stands at its final place. A button that is
// in both shapes plays only its horizontal move, if it has one (with Attach at its edge in both
// shapes, none does today), and a button that is new slides in sideways from the edge it lives on
// and fades in (`entranceOffset`). The field is not played: it never glides under a button.
//
// WHEN IT RUNS. Only when `key` changes, never per keystroke: the caller's key changes with the shape
// and with the set of buttons, which a keystroke inside an open box does not touch. The "before" is
// read during the render that sees the new key, because the DOM still shows the old shape then; the
// "after" is read in the layout effect of the same commit, before the browser paints, so no frame
// shows the new layout un-animated.
//
// `grows` false (the field layout, which has one shape) plays the entrances only: no height, no
// rows, no moves. Under `prefers-reduced-motion: reduce`, or where the browser has no
// `element.animate`, nothing is played and the change is instant.

/** How long the shape change takes, in ms. */
export const FLIP_MS = 200;
/** Fast out of the gate, a soft landing. No overshoot: nothing bounces. */
export const FLIP_EASE = "cubic-bezier(0.2, 0, 0, 1)";
/** How long a button takes to slide in, in ms. Shorter than the box, so it lands first. */
export const ENTER_MS = 150;
/** How far a new button slides in from its own edge, in px. */
export const ENTER_PX = 12;

/** A rectangle, as `getBoundingClientRect` reports it. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** A rectangle as seen from `origin`'s top left corner. */
export function relativeTo(rect: Box, origin: Box): Box {
  return { left: rect.left - origin.left, top: rect.top - origin.top, width: rect.width, height: rect.height };
}

/** Below this many pixels a move is not worth a frame of animation. */
const MOVE_EPSILON = 0.5;

/**
 * The horizontal translate that makes an element, standing at `after`, look as if it still stood at
 * `before` (both measured from the same origin), to be played back to nothing. Null when it did not
 * move sideways. A change of row is never played: the row is held still (see the header).
 */
export function invertOffset(before: Box, after: Box): number | null {
  const x = before.left - after.left;
  if (Math.abs(x) < MOVE_EPSILON) return null;
  return x;
}

/**
 * Where a new button slides in from, as a signed px offset: from the right (+) when its centre stands
 * in the right half of `container` (both measured from the same origin), from the left (-) otherwise.
 * So Send and the small microphone come in from the right, and from the left under `hand="left"`.
 */
export function entranceOffset(rect: Box, container: Box): number {
  const centre = rect.left + rect.width / 2;
  return centre > container.width / 2 ? ENTER_PX : -ENTER_PX;
}

/**
 * The edge of the box that stays put when its height changes, from its rectangle before and after
 * (viewport coordinates): `end` when the bottom edge moved no more than the top did (the box grows
 * upward, as on the pane screen), `start` when it grows downward.
 */
export function anchorEdge(before: Pick<Box, "top" | "height">, after: Pick<Box, "top" | "height">): "start" | "end" {
  const topMoved = Math.abs(after.top - before.top);
  const bottomMoved = Math.abs(after.top + after.height - (before.top + before.height));
  return bottomMoved <= topMoved ? "end" : "start";
}

/** The height keyframes of the box, or null when the two shapes are the same height. */
export function heightSpan(before: number, after: number): readonly [string, string] | null {
  if (Math.abs(before - after) < 1) return null;
  return [`${before}px`, `${after}px`];
}

interface Snapshot {
  readonly box: Box;
  readonly children: ReadonlyMap<Element, Box>;
}

/** The elements that are played: the box's direct children that are buttons. */
function movers(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.children).filter((child): child is HTMLButtonElement => child instanceof HTMLButtonElement);
}

function take(container: HTMLElement): Snapshot {
  const box = container.getBoundingClientRect();
  const children = new Map<Element, Box>();
  for (const child of movers(container)) children.set(child, relativeTo(child.getBoundingClientRect(), box));
  return { box, children };
}

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * Animate `container` when `key` changes. With `grows`: its height from the old shape to the new one,
 * its rows held at the new shape's against the edge that stays put, and each direct button child's
 * sideways move. Always: a button that is new slides in from its own edge. `enabled` false records
 * and plays nothing.
 */
export function useFlip(
  container: RefObject<HTMLElement | null>,
  key: boolean | string,
  options: { readonly enabled: boolean; readonly grows: boolean },
): void {
  const { enabled, grows } = options;
  const seen = useRef(key);
  const before = useRef<Snapshot | null>(null);
  const running = useRef<Animation[]>([]);

  // Render phase, on purpose and read-only: this render is the first to see the new key, and the DOM
  // still shows the old shape. A render that never commits leaves a snapshot nothing consumes.
  if (seen.current !== key) {
    seen.current = key;
    const element = container.current;
    before.current = enabled && element !== null ? take(element) : null;
  }

  useLayoutEffect(() => {
    const was = before.current;
    before.current = null;
    const element = container.current;
    if (was === null || element === null || reducedMotion() || !("animate" in element)) return;
    // A change that lands mid-flight starts from where the old one had got to: the snapshot above
    // already holds that (transforms included), so the old animations only need to stop here, before
    // the new layout is measured.
    for (const animation of running.current) animation.cancel();
    running.current = [];
    const now = take(element);
    const span = grows ? heightSpan(was.box.height, now.box.height) : null;
    if (span !== null) {
      // `overflow: hidden` for the length of the flight only: what the moving edge has not reached
      // yet is clipped, and a menu anchored to the box is not. The rows are the new shape's own, in
      // pixels, stood against the edge that does not move, so no row is squeezed and nothing in the
      // box moves up or down while the edge travels (the header says why).
      const rows = getComputedStyle(element).gridTemplateRows;
      const edge = anchorEdge(was.box, now.box) === "end" ? "unsafe end" : "unsafe start";
      const held = rows !== "" && rows !== "none" ? { gridTemplateRows: [rows, rows] } : {};
      running.current.push(
        element.animate(
          { height: [...span], overflow: ["hidden", "hidden"], alignContent: [edge, edge], ...held },
          { duration: FLIP_MS, easing: FLIP_EASE },
        ),
      );
    }
    const enter = { duration: ENTER_MS, easing: FLIP_EASE } as const;
    for (const [child, rect] of now.children) {
      if (!(child instanceof HTMLElement)) continue;
      const old = was.children.get(child);
      if (old === undefined) {
        const from = entranceOffset(rect, now.box);
        running.current.push(child.animate({ opacity: [0, 1], transform: [`translateX(${from}px)`, "translateX(0)"] }, enter));
        continue;
      }
      if (!grows) continue;
      const x = invertOffset(old, rect);
      if (x === null) continue;
      running.current.push(child.animate({ transform: [`translateX(${x}px)`, "translateX(0)"] }, enter));
    }
  }, [key, container, grows]);

  useLayoutEffect(
    () => () => {
      for (const animation of running.current) animation.cancel();
    },
    [],
  );
}
