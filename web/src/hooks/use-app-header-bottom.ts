import { useEffect, useState } from "react";

import { hasResizeObserver } from "@/lib/env";

// WHERE THE ONE HEADER ENDS, in px from the top of the window (M108). A floating card that must sit below
// the header's controls reads it. Measured, not summed from the header's classes, because the header's
// height is not one number: the safe-area inset, the prerelease strip on an Edge or dev build, the 60px
// row and its rule on a phone width, and on the large-screen pane layout the header is docked into the
// focused column, under the space's 48px tab row, which moves its bottom edge again
// (components/app-header.tsx, components/wide-layout.tsx).
//
// The header is found by its `data-slot="app-header"`, once per layout change: docking mounts a new
// header element in another parent, so the element watched is looked up again whenever the page's tree
// changes. The look-up is one `querySelector`; the measure runs only when the element is a new one, when it
// resizes and when the window does, and the state bails out on an equal number.

const HEADER = '[data-slot="app-header"]';

/** The header's bottom edge, or 0 while no header is mounted. */
export function useAppHeaderBottom(): number {
  const [bottom, setBottom] = useState(0);
  useEffect(() => {
    let watched: Element | null = null;
    const resizes = hasResizeObserver() ? new ResizeObserver(() => read()) : null;
    function read(): void {
      const header = document.querySelector(HEADER);
      if (header !== watched) {
        resizes?.disconnect();
        watched = header;
        if (header !== null) resizes?.observe(header);
      }
      setBottom(header === null ? 0 : Math.round(header.getBoundingClientRect().bottom));
    }
    read();
    // A change in the tree matters only when it swapped the header element; the common change is not that, and
    // measuring on every one would force a layout while a terminal streams.
    const mutations = new MutationObserver(() => {
      if (document.querySelector(HEADER) !== watched) read();
    });
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", read);
    return () => {
      resizes?.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", read);
    };
  }, []);
  return bottom;
}
