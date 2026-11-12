import { useEffect, useState } from "react";

// WITHIN ONE VIEWPORT OF THE SCREEN (M96 review): whether an element is on the screen or no more than one
// screen height above or below it, and once it has been, for good. A Decision card's image is fetched with
// the pairing token only when its card comes this near, so a hill of twenty cards does not fetch twenty
// pictures at once. The caller keeps the element's box reserved, so nothing moves when the picture lands.
//
// The margin is measured against the nearest scrolling ancestor, not only the window: the app scrolls inside
// its own box, and an observer on the window does not widen what that box clips. An element in a closed
// `Collapse` is clipped to nothing, so it counts as far away until it opens.
//
// Where the page has no IntersectionObserver (jsdom, a very old browser) the answer is yes at once: the
// picture loads as it did before this hook.

/** The nearest ancestor that scrolls on its own, or null when the page itself does. */
function scrollParent(el: Element): Element | null {
  for (let parent = el.parentElement; parent !== null; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if (overflowY === "auto" || overflowY === "scroll") return parent;
  }
  return null;
}

/** A ref callback to hand the element, and whether it is near the screen. Sticky: it never goes back to false. */
export interface NearScreen {
  ref: (el: Element | null) => void;
  near: boolean;
}

export function useNearScreen(): NearScreen {
  const [node, setNode] = useState<Element | null>(null);
  const [near, setNear] = useState(globalThis.IntersectionObserver === undefined);

  useEffect(() => {
    if (near || node === null) return;
    const root = scrollParent(node);
    const margin = root?.clientHeight || window.innerHeight;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { root, rootMargin: `${margin}px 0px` },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, near]);

  return { ref: setNode, near };
}
