import { useLayoutEffect, useRef } from "react";

import { recallScroll, rememberScroll } from "@/lib/scroll-memory";

/**
 * Restores a scrolling element's position under `key` on mount, and keeps `lib/scroll-memory.ts`
 * updated as the user scrolls. See that module's header for why this needs to exist at all —
 * ScreenTransition remounts the dashboard's scroller on every pane visit, and the document itself
 * never scrolls, so neither the DOM nor `<ScrollRestoration>` remembers this for us.
 *
 * The write happens in `useLayoutEffect`, synchronously before paint, so there is no visible flash
 * at the top before the recalled position lands.
 *
 * Usage: `<div ref={useScrollMemory(key)} className="overflow-y-auto">…</div>`.
 */
export function useScrollMemory<T extends HTMLElement = HTMLDivElement>(key: string) {
  const ref = useRef<T | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    el.scrollTop = recallScroll(key) ?? 0;

    const onScroll = () => rememberScroll(key, el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      // One last write, in case unmount races the next scroll event.
      rememberScroll(key, el.scrollTop);
    };
  }, [key]);

  return ref;
}
