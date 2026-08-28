import { Children, useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Animated presence for anything IN FLOW: the wrapper that lets a notice appear and disappear
 * without the content below it teleporting.
 *
 * This is not a new technique — it is the machinery `connection-banner.tsx:171-186` already runs,
 * lifted out so the other seven notices can stop popping. Three parts, and all three are needed:
 *
 *  1. **`grid-template-rows: 0fr ↔ 1fr`.** The one way to transition to a content-determined
 *     height in CSS. `height: auto` does not animate; a measured pixel height goes stale the
 *     moment the copy or the font changes. The child is the grid's single row, so 0fr is "no
 *     height" and 1fr is "whatever you are", and the browser interpolates between them.
 *  2. **`min-h-0 overflow-hidden` on the inner wrapper.** A grid item's automatic minimum size is
 *     its content, so without `min-h-0` the row refuses to go below its content height and 0fr
 *     does nothing at all. The clip is what hides the content while the row is short.
 *  3. **Delayed unmount.** `open` going false must not remove the child, or there is nothing left
 *     to animate out. The child stays mounted for one duration and leaves after.
 *  4. **A held copy of that child.** Keeping the child MOUNTED is not the same promise as keeping
 *     it VISIBLE, and the pilot conversion found the gap: the child is whatever the caller's render
 *     returns, so the moment the condition goes false the copy describing that condition is gone
 *     and a mounted-but-empty box slides shut on nothing — the same pop, one step quieter. So the
 *     last children that were not empty are held here and rendered for the whole exit. It belongs
 *     in this file and not at the call sites: every notice that converts would otherwise hand-roll
 *     the same ref, and seven copies of a rule is not a rule.
 *
 * It styles NOTHING. Tone, padding, borders and text all belong to what is inside it.
 */

/**
 * The in-flow speed, in milliseconds, and it is ONE number in TWO places: the CSS transition below
 * and the JavaScript that schedules the unmount. They must agree — set the timer short and the
 * child vanishes mid-slide; set it long and the row sits at zero height doing nothing for the
 * difference. `collapse.test.tsx` reads the utility off the element and compares it to this
 * constant, so an edit to either half alone fails.
 *
 * 240ms is the app's "move" speed. NOTE for whoever adds the motion tokens: the design this was
 * built from names `--dur-move` and `--ease-orbit`, and NEITHER EXISTS in `index.css` yet. Rather
 * than mint tokens from a primitive, the literal 240ms and the `ease-out` that connection-banner
 * already used are written here, once. When the tokens land, this file is the only place to change.
 */
export const COLLAPSE_MS = 240;

/** The literal that must match {@link COLLAPSE_MS}. Tailwind only sees classes it can read as text. */
const COLLAPSE_DURATION_CLASS = "duration-[240ms]";

export interface CollapseProps {
  open: boolean;
  /**
   * Rendered, not merely mounted, through the exit: the last non-empty children are held and shown
   * for the full {@link COLLAPSE_MS}, then unmounted. So a caller may return nothing at all the
   * instant its condition lifts — `{gate ? <Notice/> : null}` is the intended shape — and the box
   * still slides shut on the words that explain why it was ever there. While `open` is true the
   * children are the caller's current ones, always: nothing stale is ever shown to a caller whose
   * copy legitimately changed under it.
   */
  children: ReactNode;
  className?: string;
}

/**
 * "Empty" is exactly what React renders as nothing: `null`, `undefined`, `true`, `false`, an empty
 * array, and any nesting of those — which is precisely the set a conditional child produces
 * (`cond ? <X/> : null`, `cond && <X/>`). `Children.toArray` is the house predicate for it because
 * it drops those and keeps everything else, so the question "would this paint?" is asked once and
 * not re-derived per type. A deliberate `""` counts as content, which is correct: an empty string is
 * a caller's choice of copy, not the absence of a child.
 *
 * This matters because holding an empty snapshot is worse than holding none — it would pin the box
 * empty for every later exit, which is the very fault the hold exists to fix.
 */
function isEmpty(children: ReactNode): boolean {
  return Children.toArray(children).length === 0;
}

/**
 * `prefers-reduced-motion: reduce`, live.
 *
 * Read in JS as well as in CSS because the CSS half only stops the *paint* from animating — the
 * delayed unmount is a timer, and leaving a child in the tree for 240ms after it has already gone
 * invisible is its own small lie (a screen reader can still be walking it). Under reduced motion
 * the whole thing snaps: no transition, no delay.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return reduced;
}

export function Collapse({ open, children, className }: CollapseProps) {
  const reduced = usePrefersReducedMotion();
  const ms = reduced ? 0 : COLLAPSE_MS;

  // Three pieces of state, one job each:
  //   rendered — is the child in the tree at all (the delayed-unmount half);
  //   expanded — which end of the 0fr↔1fr transition we are heading for;
  //   settled  — has the enter transition finished, so the clip can come off (see below).
  const [rendered, setRendered] = useState(open);
  const [expanded, setExpanded] = useState(open);
  const [settled, setSettled] = useState(open);

  // The held copy (part 4 of the header). Written in an EFFECT and not during render, so this stays
  // a pure component: the effect for the render that SHOWED the children has already run by the
  // time a later render needs to read them back, which is the only ordering the exit depends on.
  // The guard is `open`, so an already-closing Collapse can never overwrite what it is busy
  // animating out, and `isEmpty`, so a caller that returns nothing does not blank the hold.
  const held = useRef<ReactNode>(null);
  useEffect(() => {
    if (open && !isEmpty(children)) held.current = children;
  }, [open, children]);

  // While open, the caller's CURRENT children — never the hold. A notice whose copy legitimately
  // changes while it stands (a host-stale age, a re-worded refusal) must show the new words at once;
  // the hold is for the exit and for nothing else.
  const content = open ? children : held.current;

  // Open at first paint means the condition was already true when the page loaded — a read-only
  // session, a stale host known at loader time. That must NOT animate in: the notice is part of
  // the first frame, so there is no shift to smooth over, and animating it would manufacture one.
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (open) {
      setRendered(true);
      setSettled(false);
      // One tick later, so the browser paints the collapsed state first and has something to
      // transition FROM. Setting both in the same commit is a jump with extra steps.
      const start = window.setTimeout(() => setExpanded(true), 0);
      const done = window.setTimeout(() => setSettled(true), ms + 16);
      return () => {
        clearTimeout(start);
        clearTimeout(done);
      };
    }
    setExpanded(false);
    setSettled(false);
    const leave = window.setTimeout(() => setRendered(false), ms);
    return () => clearTimeout(leave);
  }, [open, ms]);

  if (!rendered) return null;

  return (
    <div
      data-slot="collapse"
      data-state={expanded ? "open" : "closed"}
      className={cn(
        "grid shrink-0 transition-all ease-out motion-reduce:transition-none",
        COLLAPSE_DURATION_CLASS,
        expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        // The clip is only needed while the row is shorter than its content. Once open it is
        // actively harmful: an `overflow: hidden` ancestor eats a child's `::before` tap
        // extension, taps and all, with nothing to see — the measured failure documented at
        // STRIP_TAP_TARGET. A 33px strip's 44px action target reaches 11px past the band on both
        // sides, so every pixel of it lives outside this box. Dropping the clip when there is
        // nothing left to clip is what lets that target survive the animation it lives inside.
        settled ? "overflow-visible" : "overflow-hidden",
        className,
      )}
    >
      <div className={cn("min-h-0", settled ? "overflow-visible" : "overflow-hidden")}>{content}</div>
    </div>
  );
}
