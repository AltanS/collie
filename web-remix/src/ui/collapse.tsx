// Port of web/src/components/ui/collapse.tsx. DESIGN.md §1: "The only sanctioned way an in-flow
// surface appears or disappears: an eased 240ms height+opacity slide that holds its last child
// through the exit." §11 rule 1 and REMIX3.md rule 7: no bare `cond && <X />` in flow, no `hidden`.
//
// How it moves: `grid-template-rows` 0fr ↔ 1fr plus opacity, 240 ms ease-out. The inner wrapper is
// `min-h-0` (a grid item's automatic minimum height is its content, which would hold the row open)
// and `min-w-0` (the same rule on the other axis: one long nowrap run would size the column past the
// band). Clipping is on only while moving; once settled the clip drops, so a focus ring or a shadow
// inside is not cut.
//
// The steps, as web/ has them:
//   - closed at first: nothing in the DOM.
//   - open: mount at 0fr, flip to 1fr two frames later (the first frame must paint 0fr, or there is
//     no transition to run), drop the clip after the duration.
//   - close: back to 0fr with the LAST non-empty children still drawn, unmount after the duration.
//   - reduced motion: the CSS drops the transition (`motion-reduce:transition-none`) and the JS skips
//     the frame wait; the timer still removes the held child.
//
// The state steps are the pure `collapseStep` below, so `collapse.test.ts` checks them without a DOM.
import type { Handle, RemixNode } from "remix/component";

import { cn } from "@web/lib/utils";

import { COLLAPSE_MS, reducedMotion } from "../lib/motion";
import { scheduleUpdate } from "../lib/store";

export { COLLAPSE_MS };

const DURATION = "duration-[240ms]";

/** No content worth holding: what a bare conditional would have rendered as nothing. */
export function isEmptyNode(node: RemixNode): boolean {
  if (node === null || node === undefined || node === false || node === true || node === "") return true;
  if (Array.isArray(node)) return node.every(isEmptyNode);
  return false;
}

export interface CollapseState {
  open: boolean;
  /** In the DOM at all. */
  rendered: boolean;
  /** At 1fr and full opacity. */
  expanded: boolean;
  /** Finished moving; the clip is off. */
  settled: boolean;
  /** The last non-empty children seen while open: what an exit keeps drawing. */
  held: RemixNode;
}

export type CollapseEffect = "none" | "enter" | "exit";

/** One render's worth of change: the next state, and which timed effect to start. */
export interface CollapseTransition {
  state: CollapseState;
  effect: CollapseEffect;
}

export function collapseInitial(open: boolean, children: RemixNode): CollapseState {
  return { open, rendered: open, expanded: open, settled: open, held: open && !isEmptyNode(children) ? children : null };
}

/** One render's worth of change: the next state, and which timed effect to start (if any). */
export function collapseStep(
  prev: CollapseState,
  open: boolean,
  children: RemixNode,
  reduced: boolean,
): CollapseTransition {
  const held = open && !isEmptyNode(children) ? children : prev.held;
  if (open === prev.open) return { state: { ...prev, held }, effect: "none" };
  if (open) {
    return { state: { open, rendered: true, expanded: reduced, settled: false, held }, effect: "enter" };
  }
  return { state: { ...prev, open, expanded: false, settled: false, held }, effect: "exit" };
}

/** The two-frame start has passed: run the transition to 1fr. */
export const collapseEntered = (s: CollapseState): CollapseState => (s.open ? { ...s, expanded: true } : s);
/** The duration has passed on an open: drop the clip. */
export const collapseSettled = (s: CollapseState): CollapseState => (s.open ? { ...s, settled: true } : s);
/** The duration has passed on a close: unmount, and let go of the held children. */
export const collapseExited = (s: CollapseState): CollapseState =>
  s.open ? s : { ...s, rendered: false, held: null };

/** What the inner wrapper draws: the live children while open, the held ones through an exit. */
export function collapseContent(s: CollapseState, children: RemixNode): RemixNode {
  return s.open ? children : s.held;
}

export interface CollapseProps {
  open: boolean;
  children?: RemixNode;
  class?: string;
  /**
   * Stay mounted when closed: 0fr, transparent and `inert`, instead of leaving the DOM. Only for a
   * surface whose DOM must outlive a close, which today is the header row in zen: it holds the Collie
   * mark, and a remount would restart the mark's 37 animations (REMIX3.md rule 6).
   */
  keep?: boolean;
}

export function Collapse(handle: Handle<CollapseProps>) {
  let state = collapseInitial(handle.props.open, handle.props.children);
  // Every timed effect carries the generation it was started in; a later transition makes it stale.
  let generation = 0;
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (): void => {
    cancelAnimationFrame(frame);
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  handle.signal.addEventListener("abort", cancel, { once: true });

  const apply = (mine: number, change: (s: CollapseState) => CollapseState): void => {
    if (mine !== generation || handle.signal.aborted) return;
    state = change(state);
    scheduleUpdate(handle);
  };

  const start = (effect: CollapseEffect, reduced: boolean): void => {
    cancel();
    const mine = ++generation;
    const ms = reduced ? 0 : COLLAPSE_MS;
    // After the commit, so the first frame paints what this render drew (0fr on an enter).
    handle.queueTask(() => {
      if (effect === "enter") {
        if (!reduced) {
          frame = requestAnimationFrame(() => {
            frame = requestAnimationFrame(() => apply(mine, collapseEntered));
          });
        }
        timer = setTimeout(() => apply(mine, collapseSettled), ms + 16);
      } else {
        timer = setTimeout(() => apply(mine, collapseExited), ms);
      }
    });
  };

  return () => {
    const { open, children } = handle.props;
    if (open !== state.open) {
      const reduced = reducedMotion();
      const next = collapseStep(state, open, children, reduced);
      state = next.state;
      start(next.effect, reduced);
    } else if (open && !isEmptyNode(children)) {
      state = { ...state, held: children };
    }
    const keep = handle.props.keep === true;
    if (!state.rendered && !keep) return null;
    const closed = !state.open && !state.rendered;
    const clip = state.settled ? "overflow-visible" : "overflow-hidden";
    return (
      <div
        data-slot="collapse"
        data-state={state.expanded ? "open" : "closed"}
        inert={keep && !state.open ? true : undefined}
        aria-hidden={closed ? "true" : undefined}
        class={cn(
          "grid shrink-0 transition-all ease-out motion-reduce:transition-none",
          DURATION,
          state.expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
          clip,
          handle.props.class,
        )}
      >
        <div class={cn("min-h-0 min-w-0", clip)}>{keep ? children : collapseContent(state, children)}</div>
      </div>
    );
  };
}

export interface CollapseSwapProps {
  /** Which surface the band shows: `children` while true, `standIn` while false. */
  open: boolean;
  children?: RemixNode;
  standIn?: RemixNode;
  class?: string;
}

/**
 * Two surfaces in ONE band with ONE height motion (web/'s CollapseSwap): the full surface leaves
 * through `Collapse` while the stand-in dissolves in over it in the same grid cell, so the band
 * eases from one height to the other instead of collapsing to zero and growing back.
 */
export function CollapseSwap(handle: Handle<CollapseSwapProps>) {
  let open = handle.props.open;
  let standInMounted = !open;
  let standInShown = !open;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  handle.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });

  const after = (ms: number, mine: number, change: () => void): void => {
    clearTimeout(timer);
    handle.queueTask(() => {
      timer = setTimeout(() => {
        if (mine !== generation || handle.signal.aborted) return;
        change();
        scheduleUpdate(handle);
      }, ms);
    });
  };

  return () => {
    const next = handle.props.open;
    if (next !== open) {
      open = next;
      const mine = ++generation;
      if (!open) {
        standInMounted = true;
        after(0, mine, () => {
          standInShown = true;
        });
      } else {
        standInShown = false;
        after(reducedMotion() ? 0 : COLLAPSE_MS, mine, () => {
          standInMounted = false;
        });
      }
    }
    return (
      <div data-slot="collapse-swap" class={cn("grid shrink-0", handle.props.class)}>
        <Collapse open={open} class="col-start-1 row-start-1 min-w-0">
          {handle.props.children}
        </Collapse>
        {standInMounted ? (
          <div
            data-slot="collapse-swap-stand-in"
            inert={open}
            aria-hidden={open ? "true" : undefined}
            class={cn(
              "col-start-1 row-start-1 min-w-0 transition-opacity ease-out motion-reduce:transition-none",
              DURATION,
              standInShown ? "opacity-100" : "pointer-events-none opacity-0",
            )}
          >
            {handle.props.standIn}
          </div>
        ) : null}
      </div>
    );
  };
}
