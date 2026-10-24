import { useEffect } from "react";

// How many mounted users hold the lock, and the page's own value from before the first one took it.
// A second user must not save "none" as the value to restore, and the first to leave must not undo
// the lock while another still needs it.
let holders = 0;
let previous = "";

function take() {
  if (holders === 0) {
    previous = document.documentElement.style.overscrollBehaviorX;
    document.documentElement.style.overscrollBehaviorX = "none";
  }
  holders += 1;
}

function release() {
  holders -= 1;
  if (holders > 0) return;
  document.documentElement.style.overscrollBehaviorX = previous;
}

/**
 * Desktop Chrome turns a horizontal overscroll at the edge of the page into history back, and a
 * two-finger swipe left at the strip's first column is exactly that gesture. The strip's own
 * `overscroll-x-contain` stops the chain into the page, but the history gesture is decided on the
 * root, so the root says no too. While `active` and mounted the root refuses it. Nesting-safe: see
 * `holders`.
 */
export function useRootOverscrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    take();
    return release;
  }, [active]);
}
