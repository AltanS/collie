// Following the live tail, and remembering where a reader left a scroller.
//
// "At the bottom" is web's rule (web/src/hooks/use-auto-scroll.ts): within 24px of the end. A scroller
// that is following is pinned to the end after every commit; one the reader scrolled up stays where
// it was. The spot is kept per scroller key for the page's lifetime, so switching from Terminal to
// Chat and back, or leaving the pane and coming back, lands where the reader was.

export const AT_BOTTOM_PX = 24;

/** The three numbers the rule reads. An element satisfies it. */
export interface ScrollBox {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function isAtBottom(box: ScrollBox): boolean {
  return Math.abs(box.scrollHeight - box.scrollTop - box.clientHeight) <= AT_BOTTOM_PX;
}

export interface ScrollSpot {
  following: boolean;
  top: number;
}

const spots = new Map<string, ScrollSpot>();
/** A long session opens many panes; past this the oldest spot is forgotten. */
const MAX_SPOTS = 64;

export function rememberSpot(key: string, spot: ScrollSpot): void {
  spots.delete(key);
  spots.set(key, spot);
  if (spots.size > MAX_SPOTS) {
    const oldest = spots.keys().next().value;
    if (oldest !== undefined) spots.delete(oldest);
  }
}

/** Where the reader left `key`, or following the tail when they never scrolled it. */
export function recallSpot(key: string): ScrollSpot {
  return spots.get(key) ?? { following: true, top: 0 };
}

/**
 * The scroller's own pins to the tail. A pin moves `scrollTop`, and the browser answers with a
 * `scroll` event one frame later; content that grew in between (a Collapse opening, a late row) makes
 * that event read "not at the bottom", and a scroller that trusts it stops following the tail by
 * itself. So a scroll that lands exactly where the last pin put it is the scroller's own, not the
 * reader's: the follower re-pins instead of letting go. Any reader scroll moves `scrollTop` off that
 * spot, so it still counts.
 */
export interface TailPin {
  /** Pin `box` to its end and remember where that put it. */
  pin(box: ScrollBox): void;
  /** True when `box` sits where the last pin put it. */
  ours(box: ScrollBox): boolean;
}

export function createTailPin(): TailPin {
  let at = -1;
  return {
    pin(box) {
      box.scrollTop = box.scrollHeight;
      at = box.scrollTop;
    },
    ours(box) {
      return at >= 0 && box.scrollTop === at;
    },
  };
}
