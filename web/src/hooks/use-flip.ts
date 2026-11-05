import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

// FLIP (First, Last, Invert, Play) for the composer box's two shapes (`layout="box"`). The box
// changes shape by moving its buttons between grid cells, so the change is instant by default. This
// hook records where the box and its buttons stood, lets the new layout land, then plays the way
// from the old place to the new one with the Web Animations API: the box's height grows or shrinks,
// and each button glides from its old cell to its new one.
//
// EVERYTHING IS MEASURED AGAINST THE BOX'S OWN TOP LEFT, not the viewport. The composer is anchored
// at the bottom of the screen, so when the box grows its top edge climbs while its bottom edge stays
// put. In viewport terms the buttons barely move; in the box's own terms they slide from the first
// row to the last as the bottom edge runs away from the top. Playing the glide in the box's frame
// keeps the buttons in lockstep with that edge, so the box clips them for exactly as long as the
// edge has not yet reached their new row, and the text stays where the top edge carries it.
//
// WHEN IT RUNS. Only when `key` changes, never per keystroke: a shape change is one tap, a keystroke
// inside an open box changes no key. The "before" is read during the render that sees the new key,
// because the DOM still shows the old shape then; the "after" is read in the layout effect of the
// same commit, before the browser paints, so no frame shows the new layout un-animated.
//
// Under `prefers-reduced-motion: reduce`, or where the browser has no `element.animate`, nothing
// is played and the change is instant.

/** How long the shape change takes, in ms. */
export const FLIP_MS = 200;
/** Fast out of the gate, a soft landing. */
export const FLIP_EASE = "cubic-bezier(0.2, 0, 0, 1)";

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
 * The translate that makes an element, standing at `after`, look as if it still stood at `before`
 * (both measured from the same origin), to be played back to nothing. Null when it did not move.
 */
export function invertOffset(before: Box, after: Box): { readonly x: number; readonly y: number } | null {
  const x = before.left - after.left;
  const y = before.top - after.top;
  if (Math.abs(x) < MOVE_EPSILON && Math.abs(y) < MOVE_EPSILON) return null;
  return { x, y };
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

/**
 * The elements whose move is played: the box's direct children that are buttons, and the field. The
 * field is in because a button that glides over it would otherwise cover its first characters: it
 * starts beside Attach, where it stood at rest, and slides to the left edge as Attach leaves.
 */
function movers(container: HTMLElement): HTMLElement[] {
  return Array.from(container.children).filter(
    (child): child is HTMLButtonElement | HTMLTextAreaElement => child instanceof HTMLButtonElement || child instanceof HTMLTextAreaElement,
  );
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
 * Animate `container` when `key` changes: its height from the old shape to the new one, and each
 * direct button child, and its field, from its old place to its new one. A button that is new in the new shape fades
 * in. `enabled` false (a layout with no second shape) records and plays nothing.
 */
export function useFlip(container: RefObject<HTMLElement | null>, key: boolean | string, enabled: boolean): void {
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
    const timing = { duration: FLIP_MS, easing: FLIP_EASE } as const;
    const span = heightSpan(was.box.height, now.box.height);
    // `overflow: hidden` for the length of the flight only: the buttons that have not reached their
    // new row yet are clipped by the box's moving edge, and a menu anchored to the box is not.
    if (span !== null) running.current.push(element.animate({ height: [...span], overflow: ["hidden", "hidden"] }, timing));
    for (const [child, rect] of now.children) {
      if (!(child instanceof HTMLElement)) continue;
      const old = was.children.get(child);
      if (old === undefined) {
        running.current.push(child.animate({ opacity: [0, 1] }, timing));
        continue;
      }
      const move = invertOffset(old, rect);
      if (move === null) continue;
      running.current.push(child.animate({ transform: [`translate(${move.x}px, ${move.y}px)`, "translate(0, 0)"] }, timing));
    }
  }, [key, container]);

  useLayoutEffect(
    () => () => {
      for (const animation of running.current) animation.cancel();
    },
    [],
  );
}
