import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { usePrefersReducedMotion } from "@/components/ui/collapse";
import { HeightSwap, PRESENCE_MS, PresenceList } from "@/components/ui/presence";
import { FLIP_EASE, FLIP_MS } from "@/hooks/use-flip";
import { cn } from "@/lib/utils";

// KEYED FLOW: A COLUMN OF KEYED BLOCKS THAT AN OUTSIDE HAND REWRITES WHILE YOU READ IT.
//
// The first user is Morph (2026-11-10): an agent builds one screen block by block, so blocks arrive,
// change, move and leave while the operator looks at them. `PresenceList` (ui/presence.tsx) already does
// the arriving and the leaving; this file adds only what a list rewritten from outside needs on top, and
// builds every motion out of the primitives that exist:
//
//  1. **Arrive and leave**: `PresenceList`, unchanged. A new key grows in place, a gone key collapses
//     where it stood, and the blocks around it glide with that height.
//  2. **A change of content** (the item's `version`): a cross-fade with the height eased, through
//     `HeightSwap` keyed by the version. The old content fades out on top while the new one fades in.
//  3. **A change of order**: each block that moved glides from where it stood to where it stands now,
//     FLIP (First, Last, Invert, Play) with the Web Animations API, on the composer's own speed and
//     curve (`FLIP_MS`, `FLIP_EASE`, hooks/use-flip.ts). Only the block's own wrapper is moved, by a
//     `transform`; nothing around it is laid out again.
//  4. **The first blocks after none**: they come in one after another, {@link FLOW_STAGGER_MS} apart,
//     the first {@link FLOW_STAGGER_MAX} on their own beat and the rest with the last of those, each a
//     short fade and a {@link FLOW_RISE_PX} rise. Blocks present at the first paint are part of it and do
//     not move, as in `PresenceList`.
//  5. **A finger down holds the flow.** While a pointer is down inside the column, the column keeps
//     drawing what it drew when the finger landed, so a block never moves away under a tap or a scroll.
//     The newest items land when the finger lifts (anywhere on the page), or after
//     {@link FLOW_HOLD_MAX_MS} at the latest, so a lost `pointerup` cannot freeze it.
//
// REDUCED MOTION (`prefers-reduced-motion: reduce`): no glide, no stagger, no rise. Arriving, leaving and
// the cross-fade are the presence primitives' own reduced forms (an opacity change only).
//
// The column draws its own container: a flex column whose gap is `gap` px, the number `PresenceList`
// needs to take a leaving block's gap with it.

/** The beat between two blocks of a first screen, in ms. */
export const FLOW_STAGGER_MS = 40;
/** How many blocks get a beat of their own; the rest come in with the last of them. */
export const FLOW_STAGGER_MAX = 6;
/** How far a staggered block rises as it fades in, in px. */
export const FLOW_RISE_PX = 6;
/** The longest a finger down holds the flow, in ms. */
export const FLOW_HOLD_MAX_MS = 5000;

/** Below this many pixels a move is not worth a frame of animation. */
const MOVE_EPSILON = 0.5;

/** One block of the column: its identity, the version of what it shows, and what it draws. */
export interface FlowItem {
  readonly key: string;
  /** Changes when the content changes: a new version cross-fades the block. */
  readonly version: string;
  readonly node: ReactNode;
}

export interface KeyedFlowProps {
  items: readonly FlowItem[];
  /** The gap between blocks, in px (see `PresenceList`'s `gap`). */
  gap?: number;
  className?: string;
  "data-slot"?: string;
}

/** The delay of the `index`th block of a first screen, in ms. Exported for its test. */
export function staggerDelay(index: number): number {
  return Math.min(index, FLOW_STAGGER_MAX - 1) * FLOW_STAGGER_MS;
}

/** The blocks of this column, by key, as the elements the motions move. A nested column keeps its own. */
function cellsOf(column: HTMLElement): Map<string, HTMLElement> {
  const cells = new Map<string, HTMLElement>();
  for (const cell of column.querySelectorAll<HTMLElement>("[data-flow-key]")) {
    if (cell.closest("[data-slot-flow]") !== column) continue;
    const key = cell.dataset.flowKey;
    if (key !== undefined) cells.set(key, cell);
  }
  return cells;
}

/** Where each block's top stands, from the column's own top. */
function topsOf(column: HTMLElement): Map<string, number> {
  const origin = column.getBoundingClientRect().top;
  const tops = new Map<string, number>();
  for (const [key, cell] of cellsOf(column)) tops.set(key, cell.getBoundingClientRect().top - origin);
  return tops;
}

function canAnimate(element: HTMLElement): boolean {
  return "animate" in element;
}

/** What the finger-down hold answers: the items to draw, the call that starts a hold, and whether one runs. */
interface FingerHold {
  readonly drawn: readonly FlowItem[];
  readonly hold: () => void;
  readonly isHolding: boolean;
}

/** The finger-down hold: the items drawn while a pointer is down in the column hold still until it lifts. */
function useFingerHold(items: readonly FlowItem[]): FingerHold {
  const [held, setHeld] = useState<readonly FlowItem[] | null>(null);
  const isHolding = held !== null;

  useEffect(() => {
    if (!isHolding) return;
    const release = () => setHeld(null);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    const cap = window.setTimeout(release, FLOW_HOLD_MAX_MS);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      clearTimeout(cap);
    };
  }, [isHolding]);

  return { drawn: held ?? items, hold: () => setHeld((was) => was ?? items), isHolding };
}

/** A column of keyed blocks rewritten from outside, moving without a jump; see the header. */
export function KeyedFlow({ items, gap = 0, className, "data-slot": slot }: KeyedFlowProps) {
  const reduced = usePrefersReducedMotion();
  const column = useRef<HTMLDivElement>(null);
  const { drawn, hold, isHolding } = useFingerHold(items);
  const order = drawn.map((item) => item.key).join("\u0000");

  // FLIP's "first": read during the render that sees a new order, while the DOM still shows the old one
  // (the composer's useFlip does the same). A render that never commits leaves a reading nothing uses.
  const seen = useRef(order);
  const before = useRef<{ tops: Map<string, number>; wasEmpty: boolean } | null>(null);
  if (seen.current !== order) {
    const wasEmpty = seen.current === "";
    seen.current = order;
    const element = column.current;
    before.current = element === null || reduced ? null : { tops: topsOf(element), wasEmpty };
  }

  const running = useRef<Animation[]>([]);
  useLayoutEffect(() => {
    const was = before.current;
    before.current = null;
    const element = column.current;
    if (was === null || element === null || !canAnimate(element)) return;
    for (const animation of running.current) animation.cancel();
    running.current = [];
    const cells = cellsOf(element);
    if (was.wasEmpty) {
      [...cells.values()].forEach((cell, index) => {
        running.current.push(
          cell.animate(
            { opacity: [0, 1], transform: [`translateY(${String(FLOW_RISE_PX)}px)`, "none"] },
            { duration: PRESENCE_MS, delay: staggerDelay(index), easing: FLIP_EASE, fill: "backwards" },
          ),
        );
      });
      return;
    }
    const now = topsOf(element);
    for (const [key, top] of now) {
      const old = was.tops.get(key);
      const cell = cells.get(key);
      if (old === undefined || cell === undefined) continue;
      const dy = old - top;
      if (Math.abs(dy) < MOVE_EPSILON) continue;
      running.current.push(cell.animate({ transform: [`translateY(${String(dy)}px)`, "none"] }, { duration: FLIP_MS, easing: FLIP_EASE }));
    }
  }, [order]);

  useLayoutEffect(
    () => () => {
      for (const animation of running.current) animation.cancel();
    },
    [],
  );

  return (
    <div
      ref={column}
      data-slot={slot}
      data-slot-flow=""
      data-holding={isHolding ? "" : undefined}
      onPointerDown={hold}
      className={cn("flex min-w-0 flex-col", className)}
      style={{ gap }}
    >
      <PresenceList gap={gap}>
        {drawn.map((item) => (
          <div key={item.key} data-flow-key={item.key} className="min-w-0">
            <HeightSwap active={item.version} options={[{ key: item.version, node: item.node }]} />
          </div>
        ))}
      </PresenceList>
    </div>
  );
}
