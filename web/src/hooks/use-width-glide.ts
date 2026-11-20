import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { COLLAPSE_MS } from "@/components/ui/collapse";
import { easeOut, restingScroll, stripGeometry } from "@/lib/wide-layout";

// A WIDTH CHANGE GLIDES (wide-layout.tsx). A tap on a column's width button, or the keyboard's step,
// changes the column's `flex-basis`; with no glide the column, its right neighbours, the add column and
// the strip's scroll all jump in one frame. Here they travel together: ONE clock, ONE curve (the app's
// 240 ms "move" speed and `ease-out`, ui/collapse.tsx), the bases and the scroll written in the same
// frame, so nothing settles in a second step.
//
// WHY SCRIPT AND NOT A CSS TRANSITION. A transition on the basis would leave the layout effect reading
// the OLD widths right after the change, and the scroll has no CSS transition at all: a smooth scroll
// beside a transition runs on another clock and is clamped at call time to the range of the moment.
// So the end is computed first, from the final fractions (lib/wide-layout.ts `restingScroll`), and each
// frame writes the eased bases and then the eased scroll, which forces the layout of that frame first.
// The scroll range is linear in the bases, so a scroll between two positions in range stays in range.
//
// THE END IS REACT'S. React has already written the final bases when the layout effect runs; this only
// overrides them with the eased values until the last frame writes the same strings React wrote. A
// render in between does not touch the inline basis, because its prop did not change.
//
// SNAP. The strip is a mandatory snap container, and a browser snaps a programmatic scroll and re-snaps
// after a layout change. During a glide the strip's snap is off (inline `scroll-snap-type: none`), and
// it comes back on at rest, where the scroll is a column start or the end of the range, both snap
// positions, so nothing moves then.

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

interface Running {
  raf: number;
  from: DrawnWidths;
  to: DrawnWidths;
  /** The scroll where the glide started, and where it comes to rest. */
  scrollFrom: number;
  scrollTo: number;
  start: number;
  /** What the last frame wrote. */
  now: DrawnWidths;
  /** The person took the scroll over (a wheel or a touch on the strip): the widths go on, the scroll is theirs. */
  scrollFree: boolean;
  onEnd: () => void;
}

interface Claim {
  signature: string;
  scroll: number;
}

/** A touch that travels further than this is a scroll, not a tap: wide-layout.tsx's tap slop. */
const TAP_SLOP_PX = 10;

/** The width button, which keeps its taps during a glide. */
const WIDTH_BUTTON = '[data-slot="column-width"]';
/** Where a tap during a glide is dropped: the column heads, docked or not, and the add column. */
const HELD = '[data-slot="column-head"], [data-slot="column-header"], [data-slot="add-column"]';

const basis = (fraction: number) => `0 0 ${fraction * 100}%`;
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

function write(strip: HTMLElement, widths: DrawnWidths): void {
  const cols = strip.querySelectorAll<HTMLElement>("[data-col-index]");
  cols.forEach((col, i) => {
    const f = widths.fractions[i];
    if (f !== undefined) col.style.flex = basis(f);
  });
  const add = strip.querySelector<HTMLElement>('[data-slot="add-column"]');
  if (add !== null) add.style.flex = `0 0 ${widths.addWidth}px`;
}

function mix(from: DrawnWidths, to: DrawnWidths, p: number): DrawnWidths {
  return { fractions: to.fractions.map((f, i) => lerp(from.fractions[i] ?? f, f, p)), addWidth: lerp(from.addWidth, to.addWidth, p) };
}

export interface WidthGlide {
  /** Call from the act, BEFORE the strip is written: the person changed a width, and the change it
   *  makes draws `signature`. A claim the next layout run does not match is dropped. */
  claim: (signature: string) => void;
  /**
   * Call from the strip's layout effect on every run. True: a glide started (or took over a running
   * one) and owns the scroll until it rests. False: no glide, any running one was finished at the
   * values React drew, and the caller does what it does without one.
   */
  run: (input: GlideInput, options: { reduced: boolean; book: boolean; onEnd: () => void }) => boolean;
  /** A glide is under way. The position strip eases its segments on the same speed and curve then. */
  gliding: boolean;
}

export function useWidthGlide(scroller: RefObject<HTMLElement | null>): WidthGlide {
  const drawn = useRef<(GlideInput & { book: boolean }) | null>(null);
  const claimed = useRef<Claim | null>(null);
  const running = useRef<Running | null>(null);
  const [gliding, setGliding] = useState(false);

  const finish = useCallback((to: DrawnWidths | null) => {
    const g = running.current;
    if (g === null) return;
    running.current = null;
    cancelAnimationFrame(g.raf);
    setGliding(false);
    const node = scroller.current;
    if (node === null) return;
    if (to !== null) write(node, to);
    node.style.scrollSnapType = "";
  }, [scroller]);

  const claim = useCallback((signature: string) => {
    const node = scroller.current;
    // Read here, before React writes the new bases: once they are in, a read would lay the strip out
    // at the new widths and hand back a position already clamped to the new range.
    if (node === null) return;
    claimed.current = { signature, scroll: node.scrollLeft };
    // Set with the change, so the render that draws the new shares also carries the position strip's
    // transition; set in the layout run, the shares would already be laid out without it.
    setGliding(true);
  }, [scroller]);

  const run = useCallback<WidthGlide["run"]>(
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
        finish(book ? null : input);
        setGliding(false);
        return false;
      }

      const g = running.current;
      // A tap during a glide goes on from where the strip is now to the new end; the end is computed
      // from where the last glide was going, which is where the strip would stand without one. If the
      // person took the scroll during that glide, the strip stands where they left it, so the end is
      // computed from there, as the jump computes it from the live position.
      const from = g?.now ?? prev;
      const base = g !== null && !g.scrollFree ? g.scrollTo : ask.scroll;
      if (g !== null) cancelAnimationFrame(g.raf);
      const viewport = node.clientWidth;
      const scrollTo = restingScroll(stripGeometry(input.fractions, input.stripWidth, input.wide), input.focusAt, base, viewport);
      const to: DrawnWidths = { fractions: input.fractions, addWidth: input.addWidth };
      const next: Running = {
        raf: 0,
        from,
        to,
        scrollFrom: ask.scroll,
        scrollTo,
        start: performance.now(),
        now: from,
        // A new width act owns the scroll again, from where the person left it.
        scrollFree: false,
        onEnd,
      };
      running.current = next;
      // The first frame, before paint: the strip as it was, so React's final bases never show.
      node.style.scrollSnapType = "none";
      write(node, from);
      if (!next.scrollFree) node.scrollLeft = ask.scroll;

      const frame = (time: number) => {
        if (running.current !== next) return;
        const p = easeOut(Math.min(1, Math.max(0, time - next.start) / COLLAPSE_MS));
        const now = p >= 1 ? to : mix(from, to, p);
        next.now = now;
        write(node, now);
        if (!next.scrollFree) node.scrollLeft = p >= 1 ? scrollTo : lerp(next.scrollFrom, scrollTo, p);
        if (p < 1) {
          next.raf = requestAnimationFrame(frame);
          return;
        }
        running.current = null;
        node.style.scrollSnapType = "";
        setGliding(false);
        next.onEnd();
      };
      next.raf = requestAnimationFrame(frame);
      return true;
    },
    [scroller, finish],
  );

  // A wheel, or a finger that MOVES on the strip, during a glide: the person scrolls, and the glide stops
  // writing the scroll. A finger that only taps (a quick second tap on the width button) frees nothing:
  // the touch frees the scroll at its first `touchmove` past the tap slop, the column's own 10 px.
  // A TAP IN FLIGHT: the width button sits at the trailing end of its column's header, so it travels with
  // the column's edge, and a quick second tap at the same screen point can land on what slides under it:
  // the column's Remove from view, the header's other buttons, a neighbour's header, the add column. While
  // a glide runs, a tap there is a tap aimed at the width button, so it is dropped; the width button itself
  // still takes it (a second tap goes on to the next width). At rest the point holds what the jump left
  // there, as before.
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
      if (running.current === null || !(e.target instanceof Element)) return;
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

  useEffect(() => () => {
    const g = running.current;
    if (g !== null) cancelAnimationFrame(g.raf);
    running.current = null;
  }, []);

  return useMemo(() => ({ claim, run, gliding }), [claim, run, gliding]);
}
