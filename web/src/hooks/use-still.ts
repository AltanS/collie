import { useEffect, useState } from "react";

import { hasResizeObserver } from "@/lib/env";

/** How long a card must hold its place before its yes can be tapped. */
export const STILL_MS = 1000;
/** How often the place is looked at. A whole number of these makes {@link STILL_MS}. */
export const STILL_TICK_MS = 100;

/** A box's place and size on the screen, rounded, with the visual viewport's (the soft keyboard moves it). */
function screenPlace(el: Element): string {
  const box = el.getBoundingClientRect();
  const vv = window.visualViewport;
  const view = vv === null || vv === undefined ? [] : [vv.offsetTop, vv.offsetLeft, vv.width, vv.height];
  return [box.top, box.left, box.width, box.height, ...view].map(Math.round).join(",");
}

/** A box's place in a scroll box's content, rounded: only a shift in the content or a change of size moves it. */
function contentPlace(el: Element, within: Element): string {
  const box = el.getBoundingClientRect();
  const frame = within.getBoundingClientRect();
  return [box.top - frame.top + within.scrollTop, box.left - frame.left + within.scrollLeft, box.width, box.height].map(Math.round).join(",");
}

/**
 * Where a card is, rounded: two reads differ when it moved or changed size. Always the place of `screen`
 * (the yes, or the card itself) on the SCREEN, so whatever moves it under a finger counts: the person's own
 * scroll, a dock card that comes or goes, the keyboard, a floating composer card. With `within` (the scroll
 * box the card flows in) also the card's place in that box's content, so a row put in above it counts even
 * where the list re-pins and the screen place comes back.
 */
function placeOf(el: Element, within: Element | null, screen: Element | null): string {
  const onScreen = screenPlace(screen ?? el);
  return within === null ? onScreen : `${contentPlace(el, within)}|${onScreen}`;
}

/**
 * Whether `el` has held its place on screen for {@link STILL_MS} (security read of package I, 2026-11-17,
 * point 2). A card above a dock can drop into the place a thumb is already heading for, so a yes that
 * must not be tapped by accident waits for the card to stand still: from the draw, and again after every
 * shift, resize or scroll. `null` for `el` is never still. A new `key` (another card of the group, or the
 * card's read check turning true) starts the wait again.
 *
 * `within` is the scroll box a card flows in like a message, `screen` the box whose place on the screen is
 * watched (the yes; default `el`). Every move of either restarts the second, the person's own scroll too:
 * the wait then ends a second after the scroll stops, so reading down never keeps the yes off for ever
 * (read of f1d386c21, point 1).
 */
export function useStill(el: HTMLElement | null, key: string, within: HTMLElement | null = null, screen: HTMLElement | null = null): boolean {
  const [state, setState] = useState({ key: "", still: false });
  useEffect(() => {
    if (el === null) return;
    let last = placeOf(el, within, screen);
    let calm = 0;
    const restart = () => {
      calm = 0;
      setState((prev) => (prev.key === key && !prev.still ? prev : { key, still: false }));
    };
    restart();
    const timer = setInterval(() => {
      const now = placeOf(el, within, screen);
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
          last = placeOf(el, within, screen);
          restart();
        })
      : null;
    observer?.observe(el);
    if (screen !== null && screen !== el) observer?.observe(screen);
    // The keyboard opening or closing moves the visual viewport: wait again at once, not at the next look.
    const vv = window.visualViewport;
    const moved = () => {
      last = placeOf(el, within, screen);
      restart();
    };
    vv?.addEventListener("resize", moved);
    vv?.addEventListener("scroll", moved);
    return () => {
      clearInterval(timer);
      observer?.disconnect();
      vv?.removeEventListener("resize", moved);
      vv?.removeEventListener("scroll", moved);
    };
  }, [el, key, within, screen]);
  return el !== null && state.key === key && state.still;
}
