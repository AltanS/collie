import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { restingScroll, springAt, springRests, stripGeometry, type SpringState } from "@/lib/wide-layout";

// THE VIEW MOVES ON ONE SPRING (wide-layout.tsx), the way niri moves its view and resizes its windows:
// a critically damped spring, niri's own defaults (lib/wide-layout.ts `springAt`). Two acts drive it:
//
// - A WIDTH CHANGE (a tap on a column's width button, the keyboard's step): each column's fraction, the
//   add column's px and the strip's scroll each get a spring, all on the same rate and the same clock, so
//   the column, its right neighbours, the add column and the scroll travel as one and nothing settles in
//   a second step.
// - A FOCUS FOLLOW (a tap on another column, the keyboard's focus step, the follow after a column opens
//   or closes): the scroll alone, on the same spring, in place of the browser's own smooth scroll.
//
// A second act during a motion RETARGETS it: every spring goes on from where it is WITH the speed it has,
// as niri's springs do, so there is no restart from rest and no kink. With that speed a value may pass
// its end a little on the way; it always comes to rest on the end.
//
// WHY SCRIPT AND NOT A CSS TRANSITION. A transition on the basis would leave the layout effect reading
// the OLD widths right after the change, and the scroll has no CSS transition at all. So the end is
// computed first, from the final fractions (lib/wide-layout.ts `restingScroll`), and each frame writes
// the bases and then the scroll, which forces the layout of that frame first.
//
// THE END IS REACT'S. React has already written the final bases when the layout effect runs; this only
// overrides them until the last frame writes the same strings React wrote. A render in between does not
// touch the inline basis, because its prop did not change.
//
// THE STOP RULE (lib/wide-layout.ts `springRests`): every spring within half a CSS pixel of its end and
// moving under half a pixel a frame. Then the last frame writes the exact ends.
//
// SNAP. The strip is a mandatory snap container, and a browser snaps a programmatic scroll and re-snaps
// after a layout change. While the view moves the strip's snap is off (inline `scroll-snap-type: none`),
// and it comes back on at rest, where the scroll is a column start or the end of the range, both snap
// positions, so nothing moves then. `useStripSnap` settles only a wheel gesture, so it never reads these
// frames as one.

/** What the strip draws now: the columns' fractions and the add column's px. */
export interface DrawnWidths {
  readonly fractions: readonly number[];
  readonly addWidth: number;
}

/** What one layout effect run hands the glide: the strip as React just drew it. */
export interface GlideInput extends DrawnWidths {
  readonly signature: string;
  readonly stripWidth: number;
  readonly wide: boolean;
  readonly focusAt: number;
}

interface Spring {
  x: number;
  v: number;
  to: number;
}

interface Running {
  raf: number;
  /** The time of the frame the springs stand at, ms. */
  at: number;
  /** A width change: one spring per column's fraction and one for the add column. Null for a follow. */
  cols: Spring[] | null;
  add: Spring | null;
  scroll: Spring;
  /** A strip's width, to read a fraction's rest in pixels. */
  unit: number;
  /** The person took the scroll over (a wheel or a moving finger): the widths go on, the scroll is theirs. */
  scrollFree: boolean;
  onEnd: () => void;
}

interface Claim {
  signature: string;
  scroll: number;
}

/** A touch that travels further than this is a scroll, not a tap: wide-layout.tsx's tap slop. */
const TAP_SLOP_PX = 10;

/** The width button, which keeps its taps during a width change. */
const WIDTH_BUTTON = '[data-slot="column-width"]';
/** Where a tap during a width change is dropped: the column heads, docked or not, and the add column. */
const HELD = '[data-slot="column-head"], [data-slot="column-header"], [data-slot="add-column"]';

const basis = (fraction: number) => `0 0 ${fraction * 100}%`;

function writeWidths(strip: HTMLElement, fractions: readonly number[], addWidth: number): void {
  const cols = strip.querySelectorAll<HTMLElement>("[data-col-index]");
  cols.forEach((col, i) => {
    const f = fractions[i];
    if (f !== undefined) col.style.flex = basis(f);
  });
  const add = strip.querySelector<HTMLElement>('[data-slot="add-column"]');
  if (add !== null) add.style.flex = `0 0 ${addWidth}px`;
}

function step(s: Spring, dt: number): SpringState {
  const next = springAt(s.x, s.to, s.v, dt);
  s.x = next.x;
  s.v = next.v;
  return next;
}

export interface ViewGlide {
  /** Call from the act, BEFORE the strip is written: the person changed a width, and the change it
   *  makes draws `signature`. A claim the next layout run does not match is dropped. */
  claim: (signature: string) => void;
  /**
   * Call from the strip's layout effect on every run. True: a width glide started (or took over a
   * running motion) and owns the scroll until it rests. False: no glide, any running width glide was
   * finished at the values React drew, and the caller does what it does without one.
   */
  run: (input: GlideInput, options: { reduced: boolean; book: boolean; onEnd: () => void }) => boolean;
  /** Move the strip's scroll to `left` on the spring (a focus follow). Reduced motion, or a strip with no
   *  layout, jumps. A running motion is retargeted with the speed it has. */
  follow: (left: number, options: { reduced: boolean; onEnd: () => void }) => void;
  /** A width glide is under way. The position strip eases its segments then, and taps are held. */
  gliding: boolean;
}

export function useViewGlide(scroller: RefObject<HTMLElement | null>): ViewGlide {
  const drawn = useRef<(GlideInput & { book: boolean }) | null>(null);
  const claimed = useRef<Claim | null>(null);
  const running = useRef<Running | null>(null);
  const [gliding, setGliding] = useState(false);

  /** Stop the motion where it is. With `to`, a width glide's bases are set to React's (`to`) first. */
  const finish = useCallback(
    (to: DrawnWidths | null) => {
      const g = running.current;
      if (g === null) return;
      running.current = null;
      cancelAnimationFrame(g.raf);
      setGliding(false);
      const node = scroller.current;
      if (node === null) return;
      if (to !== null && g.cols !== null) writeWidths(node, to.fractions, to.addWidth);
      node.style.scrollSnapType = "";
    },
    [scroller],
  );

  const frame = useCallback(
    (time: number) => {
      const g = running.current;
      const node = scroller.current;
      if (g === null || node === null) return;
      const dt = Math.max(0, time - g.at) / 1000;
      g.at = Math.max(g.at, time);
      let rests = true;
      if (g.cols !== null && g.add !== null) {
        for (const c of g.cols) if (!springRests(step(c, dt), c.to, g.unit)) rests = false;
        if (!springRests(step(g.add, dt), g.add.to)) rests = false;
      }
      if (!g.scrollFree && !springRests(step(g.scroll, dt), g.scroll.to)) rests = false;
      if (rests) {
        // The exact ends, the same strings React wrote.
        if (g.cols !== null && g.add !== null) writeWidths(node, g.cols.map((c) => c.to), g.add.to);
        if (!g.scrollFree) node.scrollLeft = g.scroll.to;
        running.current = null;
        node.style.scrollSnapType = "";
        if (g.cols !== null) setGliding(false);
        g.onEnd();
        return;
      }
      if (g.cols !== null && g.add !== null) writeWidths(node, g.cols.map((c) => c.x), g.add.x);
      if (!g.scrollFree) node.scrollLeft = g.scroll.x;
      g.raf = requestAnimationFrame(frame);
    },
    [scroller],
  );

  /** Start (or keep) the frame loop for `g`, which is now the running motion. */
  const start = useCallback(
    (g: Running, node: HTMLElement) => {
      running.current = g;
      node.style.scrollSnapType = "none";
      cancelAnimationFrame(g.raf);
      g.raf = requestAnimationFrame(frame);
    },
    [frame],
  );

  const claim = useCallback(
    (signature: string) => {
      const node = scroller.current;
      // Read here, before React writes the new bases: once they are in, a read would lay the strip out
      // at the new widths and hand back a position already clamped to the new range.
      if (node === null) return;
      claimed.current = { signature, scroll: node.scrollLeft };
      // Set with the change, so the render that draws the new shares also carries the position strip's
      // transition; set in the layout run, the shares would already be laid out without it.
      setGliding(true);
    },
    [scroller],
  );

  const run = useCallback<ViewGlide["run"]>(
    (input, { reduced, book, onEnd }) => {
      const prev = drawn.current;
      drawn.current = { ...input, book };
      const ask = claimed.current;
      claimed.current = null;
      const node = scroller.current;
      const glides =
        ask !== null &&
        ask.signature === input.signature &&
        node !== null &&
        node.clientWidth > 0 &&
        !reduced &&
        !book &&
        input.wide &&
        prev !== null &&
        !prev.book &&
        prev.wide &&
        prev.stripWidth === input.stripWidth &&
        prev.fractions.length === input.fractions.length &&
        prev.signature !== input.signature;
      if (!glides || node === null || ask === null || prev === null) {
        // A follow that runs alone is the caller's to keep or retarget; a width glide ends here.
        if (running.current?.cols !== null) finish(book ? null : input);
        setGliding(false);
        return false;
      }

      const g = running.current;
      // A second act during a motion goes on from where each value is, with the speed it has. Its end is
      // computed from where the scroll was going, which is where the strip would stand without the
      // motion; if the person took the scroll during it, from where they left the strip.
      const scrollBase = g !== null && !g.scrollFree ? g.scroll.to : ask.scroll;
      const viewport = node.clientWidth;
      const scrollTo = restingScroll(stripGeometry(input.fractions, input.stripWidth, input.wide), input.focusAt, scrollBase, viewport);
      const cols = input.fractions.map((to, i) => {
        const was = g?.cols?.[i];
        return was !== undefined ? { x: was.x, v: was.v, to } : { x: prev.fractions[i] ?? to, v: 0, to };
      });
      const add = g?.add != null ? { x: g.add.x, v: g.add.v, to: input.addWidth } : { x: prev.addWidth, v: 0, to: input.addWidth };
      // A new width act owns the scroll again, from where it is now (read in `claim`).
      const scroll = { x: ask.scroll, v: g !== null && !g.scrollFree ? g.scroll.v : 0, to: scrollTo };
      const next: Running = { raf: g?.raf ?? 0, at: performance.now(), cols, add, scroll, unit: input.stripWidth, scrollFree: false, onEnd };
      start(next, node);
      // The first frame, before paint: the strip as it was, so React's final bases never show.
      writeWidths(node, cols.map((c) => c.x), add.x);
      node.scrollLeft = scroll.x;
      return true;
    },
    [scroller, finish, start],
  );

  const follow = useCallback<ViewGlide["follow"]>(
    (left, { reduced, onEnd }) => {
      const node = scroller.current;
      if (node === null) return;
      const g = running.current;
      if (reduced || node.clientWidth === 0) {
        if (g !== null) finish(g.cols === null ? null : drawn.current);
        node.scrollTo?.({ left, behavior: "auto" });
        return;
      }
      // Retarget: the scroll goes on from where it is, with its speed, to the new place.
      if (g !== null) {
        const live = g.scrollFree ? { x: node.scrollLeft, v: 0 } : { x: g.scroll.x, v: g.scroll.v };
        g.scroll = { ...live, to: left };
        g.scrollFree = false;
        g.onEnd = onEnd;
        return;
      }
      if (Math.abs(node.scrollLeft - left) <= 0.5) return;
      start({ raf: 0, at: performance.now(), cols: null, add: null, scroll: { x: node.scrollLeft, v: 0, to: left }, unit: 1, scrollFree: false, onEnd }, node);
    },
    [scroller, finish, start],
  );

  // A wheel, or a finger that MOVES on the strip, during a motion: the person scrolls, and the motion
  // stops writing the scroll. A finger that only taps (a quick second tap on the width button) frees
  // nothing: the touch frees the scroll at its first `touchmove` past the tap slop, the column's own 10 px.
  // A TAP IN FLIGHT: the width button sits at the trailing end of its column's header, so it travels with
  // the column's edge, and a quick second tap at the same screen point can land on what slides under it:
  // the column's Remove from view, the header's other buttons, a neighbour's header, the add column. While
  // a width glide runs, a tap there is a tap aimed at the width button, so it is dropped; the width button
  // itself still takes it (a second tap goes on to the next width). At rest the point holds what the
  // jump left there, as before.
  useEffect(() => {
    const node = scroller.current;
    if (node === null) return;
    const free = () => {
      if (running.current !== null) running.current.scrollFree = true;
    };
    let touchAt: { x: number; y: number } | null = null;
    const touchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      touchAt = t === undefined ? null : { x: t.clientX, y: t.clientY };
    };
    const touchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (touchAt === null || t === undefined) return;
      if (Math.hypot(t.clientX - touchAt.x, t.clientY - touchAt.y) > TAP_SLOP_PX) free();
    };
    const touchEnd = () => {
      touchAt = null;
    };
    const hold = (e: Event) => {
      if (running.current?.cols == null || !(e.target instanceof Element)) return;
      if (e.target.closest(WIDTH_BUTTON) !== null || e.target.closest(HELD) === null) return;
      e.preventDefault();
      e.stopPropagation();
    };
    node.addEventListener("wheel", free, { passive: true });
    node.addEventListener("touchstart", touchStart, { passive: true });
    node.addEventListener("touchmove", touchMove, { passive: true });
    node.addEventListener("touchend", touchEnd, { passive: true });
    node.addEventListener("touchcancel", touchEnd, { passive: true });
    node.addEventListener("click", hold, { capture: true });
    node.addEventListener("pointerup", hold, { capture: true });
    return () => {
      node.removeEventListener("wheel", free);
      node.removeEventListener("touchstart", touchStart);
      node.removeEventListener("touchmove", touchMove);
      node.removeEventListener("touchend", touchEnd);
      node.removeEventListener("touchcancel", touchEnd);
      node.removeEventListener("click", hold, { capture: true });
      node.removeEventListener("pointerup", hold, { capture: true });
    };
  }, [scroller]);

  useEffect(
    () => () => {
      const g = running.current;
      if (g !== null) cancelAnimationFrame(g.raf);
      running.current = null;
    },
    [],
  );

  return useMemo(() => ({ claim, run, follow, gliding }), [claim, run, follow, gliding]);
}
