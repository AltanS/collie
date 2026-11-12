import { useEffect, useRef, useState, type RefObject } from "react";

// A LIST HELD STILL UNDER A FINGER (hitbox investigation, proposal 2).
//
// The dashboard polls, and a poll that brings a new pane or drops one moves every row under it by a row's
// height. A finger that landed before the poll and lifts after it taps a NEIGHBOUR (measured: 179 of 200
// touches when a row arrived, 182 of 200 when one left). `lib/press-memory.ts` repairs the tap that already
// went wrong; this keeps it from going wrong: while a finger is down on the list, and for `STILL_QUIET_MS`
// after it lifts, the list's STRUCTURE is held where the person last saw it.
//
// WHAT WAITS, AND WHAT DOES NOT.
//   - ARRIVAL waits: a pane that is not in the held list is not drawn.
//   - REMOVAL waits: a pane that is in the held list stays, as it was last drawn.
//   - ORDER waits: the held list keeps its own order. (A row's place never depends on its state in this app, so
//     order only changes with arrival and removal; the Activity and Cache orders are already one reading held
//     by hooks/use-frozen-ranks.ts, which a poll never re-takes, and this composes with it: it holds the SET.)
//   - A pane's DATA does not wait. Every pane in the held list is drawn from the LIVE copy, so a status, an
//     attention mark, a name or a count changes in place the moment a poll brings it. The summary line, the
//     counts and every other reading of the whole herd are not passed through this hook at all.
//
// A LIST THAT IS NOT TOUCHED IS NOT DELAYED: with no finger in play the hook returns `live` itself, the very
// array, with no timer running and nothing copied.
//
// WHICH FINGER. A touch that starts inside `root` (a touch is followed to its end by touch events, which
// keep coming through a scroll, where pointer events stop at `pointercancel`), and a mouse or pen button
// pressed inside it. The quiet time starts when the LAST finger lifts.

/** The list stays held this long after the last finger lifts: past the click that follows a lift. */
export const STILL_QUIET_MS = 300;

export function useStillWhileTouched<T>(
  live: readonly T[],
  keyOf: (item: T) => string,
  root: RefObject<HTMLElement | null>,
): readonly T[] {
  // The list as it was drawn at the moment a finger landed; null while nothing holds the list.
  const [held, setHeld] = useState<readonly T[] | null>(null);
  const drawn = useRef<readonly T[]>(live);
  const items = held === null ? live : merge(held, live, keyOf);
  useEffect(() => {
    drawn.current = items;
  });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Fingers down inside the list, by id: a touch's identifier, or "mouse".
    const down = new Set<string>();
    const inside = (target: EventTarget | null) => {
      const el = root.current;
      return el !== null && target instanceof Node && el.contains(target);
    };
    const begin = (id: string) => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      down.add(id);
      setHeld((prev) => prev ?? drawn.current);
    };
    const end = (id: string) => {
      if (!down.delete(id) || down.size > 0) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        setHeld(null);
      }, STILL_QUIET_MS);
    };
    const onTouchStart = (e: TouchEvent) => {
      for (const t of e.changedTouches) if (inside(t.target)) begin(`touch${String(t.identifier)}`);
    };
    const onTouchEnd = (e: TouchEvent) => {
      for (const t of e.changedTouches) end(`touch${String(t.identifier)}`);
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== "touch" && inside(e.target)) begin("pointer");
    };
    const onPointerEnd = (e: PointerEvent) => {
      if (e.pointerType !== "touch") end("pointer");
    };
    document.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    document.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
    document.addEventListener("touchcancel", onTouchEnd, { capture: true, passive: true });
    document.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
    document.addEventListener("pointerup", onPointerEnd, { capture: true, passive: true });
    document.addEventListener("pointercancel", onPointerEnd, { capture: true, passive: true });
    return () => {
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("touchstart", onTouchStart, { capture: true });
      document.removeEventListener("touchend", onTouchEnd, { capture: true });
      document.removeEventListener("touchcancel", onTouchEnd, { capture: true });
      document.removeEventListener("pointerdown", onPointerDown, { capture: true });
      document.removeEventListener("pointerup", onPointerEnd, { capture: true });
      document.removeEventListener("pointercancel", onPointerEnd, { capture: true });
    };
  }, [root]);

  return items;
}

/** The held list, each item replaced by its live copy where it still exists. Held order, no arrivals. */
function merge<T>(held: readonly T[], live: readonly T[], keyOf: (item: T) => string): readonly T[] {
  const byKey = new Map(live.map((item) => [keyOf(item), item]));
  return held.map((item) => byKey.get(keyOf(item)) ?? item);
}
