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
//   - ORDER waits: the held list keeps its own order. (In the full list a row's place never depends on its
//     state, so its order only changes with arrival and removal; the Activity and Cache orders are already one
//     reading held by hooks/use-frozen-ranks.ts, which a poll never re-takes, and this composes with it: it
//     holds the SET. The one place a state decides who is DRAWN is the needs-you switch: see the next point.)
//   - A pane's DATA does not wait. Every pane in the held list is drawn from the LIVE copy, so a status, an
//     attention mark, a name or a count changes in place the moment a poll brings it. The summary line, the
//     counts and every other reading of the whole herd are not passed through this hook at all.
//   - WHICH ROWS A STATE-BASED FILTER KEEPS waits too. The needs-you switch keeps a row because of its status,
//     so a status that turned a row idle would take it out and slide the next one under the finger. `frozen`
//     is the list as the finger found it: AgentList asks it who needed you THEN (agent-list.tsx), and the rows
//     that stay are still drawn with their live status.
//
// A LIST THAT IS NOT TOUCHED IS NOT DELAYED: with no finger in play the hook returns `live` itself, the very
// array, with no timer running and nothing copied.
//
// WHICH FINGER. A touch that starts inside `root` (a touch is followed to its end by touch events, which
// keep coming through a scroll, where pointer events stop at `pointercancel`), and a mouse or pen button
// pressed inside it. The quiet time starts when the LAST finger lifts.

/** The list stays held this long after the last finger lifts: past the click that follows a lift. */
export const STILL_QUIET_MS = 300;

/**
 * No hold lasts longer than this, whatever the events say. A touch's end is told to the node the touch began on,
 * and React can remove that node while the finger is down (a row that left the list): the `touchend` then goes
 * to a detached node and never reaches the document, and the finger would be "down" for good. A real press and
 * hold, or a slow scroll with a finger on the glass, is over long before this.
 */
export const STILL_MAX_HOLD_MS = 5000;

export function useStillWhileTouched<T>(
  live: readonly T[],
  keyOf: (item: T) => string,
  root: RefObject<HTMLElement | null>,
): readonly T[] {
  return useStillList(live, keyOf, root).items;
}

/** The list as drawn, and the held copy it is drawn from. */
export interface StillList<T> {
  /** What to draw: the live list itself when untouched, else the held list with each pane's live copy. */
  items: readonly T[];
  /**
   * The list exactly as it was drawn when the finger landed, each pane as it was THEN, `null` when nothing holds the
   * list. A filter that decides which rows are drawn from a pane's state (the needs-you switch) reads this to keep
   * its answer where the person last saw it, while the rows themselves show the live state.
   */
  frozen: readonly T[] | null;
}

export function useStillList<T>(
  live: readonly T[],
  keyOf: (item: T) => string,
  root: RefObject<HTMLElement | null>,
): StillList<T> {
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
    let maxTimer: ReturnType<typeof setTimeout> | null = null;
    const release = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (maxTimer !== null) clearTimeout(maxTimer);
      maxTimer = null;
      down.clear();
      setHeld(null);
    };
    const begin = (id: string) => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      down.add(id);
      // The ceiling counts from the first finger and is not restarted by a later one: see STILL_MAX_HOLD_MS.
      maxTimer ??= setTimeout(release, STILL_MAX_HOLD_MS);
      setHeld((prev) => prev ?? drawn.current);
    };
    const end = (id: string) => {
      if (!down.delete(id) || down.size > 0) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(release, STILL_QUIET_MS);
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
      if (e.pointerType !== "touch") {
        end("pointer");
        return;
      }
      // A finger that LIFTS, told by the pointer: it is raised on the document even when the touch's own node
      // has been removed, which its `touchend` is not. Not `pointercancel`: a scroll cancels the pointer while
      // the finger is still down. Two fingers: the first lift lets both go early, which only makes the list
      // current sooner, and the last `touchend` finds nothing left to end.
      if (e.type !== "pointerup") return;
      for (const id of down) if (id.startsWith("touch")) end(id);
    };
    document.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    document.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
    document.addEventListener("touchcancel", onTouchEnd, { capture: true, passive: true });
    document.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
    document.addEventListener("pointerup", onPointerEnd, { capture: true, passive: true });
    document.addEventListener("pointercancel", onPointerEnd, { capture: true, passive: true });
    return () => {
      if (timer !== null) clearTimeout(timer);
      if (maxTimer !== null) clearTimeout(maxTimer);
      document.removeEventListener("touchstart", onTouchStart, { capture: true });
      document.removeEventListener("touchend", onTouchEnd, { capture: true });
      document.removeEventListener("touchcancel", onTouchEnd, { capture: true });
      document.removeEventListener("pointerdown", onPointerDown, { capture: true });
      document.removeEventListener("pointerup", onPointerEnd, { capture: true });
      document.removeEventListener("pointercancel", onPointerEnd, { capture: true });
    };
  }, [root]);

  return { items, frozen: held };
}

/** The held list, each item replaced by its live copy where it still exists. Held order, no arrivals. */
function merge<T>(held: readonly T[], live: readonly T[], keyOf: (item: T) => string): readonly T[] {
  const byKey = new Map(live.map((item) => [keyOf(item), item]));
  return held.map((item) => byKey.get(keyOf(item)) ?? item);
}
