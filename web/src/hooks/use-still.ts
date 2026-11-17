import { useEffect, useState } from "react";

import { hasResizeObserver } from "@/lib/env";

/** How long a card must hold its place before its yes can be tapped. */
export const STILL_MS = 1000;
/** How often the place is looked at. A whole number of these makes {@link STILL_MS}. */
export const STILL_TICK_MS = 100;

/**
 * A box's place and size, rounded: two reads differ only when the box moved or changed size. With `within`
 * (the scroll box the card flows in), the place is the box's place in that scroll box's content, so the
 * person scrolling the box moves nothing, and anything put in above the card, or the card's own change of
 * size, still does. Without it, the place on the screen.
 */
function placeOf(el: Element, within: Element | null): string {
  const box = el.getBoundingClientRect();
  if (within === null) return [box.top, box.left, box.width, box.height].map(Math.round).join(",");
  const frame = within.getBoundingClientRect();
  return [box.top - frame.top + within.scrollTop, box.left - frame.left + within.scrollLeft, box.width, box.height].map(Math.round).join(",");
}

/**
 * Whether `el` has held its place on screen for {@link STILL_MS} (security read of package I, 2026-11-17,
 * point 2). A card above a dock can drop into the place a thumb is already heading for, so a yes that
 * must not be tapped by accident waits for the card to stand still: from the draw, and again after every
 * shift, resize or scroll. `null` for `el` is never still. A new `key` (another card of the group)
 * starts the wait again.
 *
 * `within` is the scroll box a card flows in like a message (the chat's trick card, 2026-11-17): the person
 * scrolling it to read is not a shift, so it does not keep the yes off for ever; a row put in above the card,
 * the card growing or shrinking, or the box's content moving under the card is, and waits again.
 */
export function useStill(el: HTMLElement | null, key: string, within: HTMLElement | null = null): boolean {
  const [state, setState] = useState({ key: "", still: false });
  useEffect(() => {
    if (el === null) return;
    let last = placeOf(el, within);
    let calm = 0;
    const restart = () => {
      calm = 0;
      setState((prev) => (prev.key === key && !prev.still ? prev : { key, still: false }));
    };
    restart();
    const timer = setInterval(() => {
      const now = placeOf(el, within);
      if (now !== last) {
        last = now;
        restart();
        return;
      }
      calm += 1;
      if (calm * STILL_TICK_MS >= STILL_MS) setState((prev) => (prev.key === key && prev.still ? prev : { key, still: true }));
    }, STILL_TICK_MS);
    const observer = hasResizeObserver()
      ? new ResizeObserver(() => {
          last = placeOf(el, within);
          restart();
        })
      : null;
    observer?.observe(el);
    return () => {
      clearInterval(timer);
      observer?.disconnect();
    };
  }, [el, key, within]);
  return el !== null && state.key === key && state.still;
}
