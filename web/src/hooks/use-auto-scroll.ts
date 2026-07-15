import { useCallback, useEffect, useRef, useState } from "react";

interface UseAutoScrollOptions {
  /** Px distance from the bottom still considered "at bottom". */
  offset?: number;
  /** Any value that changes when new content is appended — drives the auto-scroll effect. */
  dep?: unknown;
  /** Fires when the at-bottom state changes — lets a parent follow live output or freeze it. */
  onAtBottomChange?: (atBottom: boolean) => void;
}

// Keeps a scroll container pinned to the bottom as content grows, but yields control the moment
// the user scrolls up to read backscroll (and offers a button to jump back down).
export function useAutoScroll<T extends HTMLElement = HTMLDivElement>(
  options: UseAutoScrollOptions = {},
) {
  const { offset = 24, dep, onAtBottomChange } = options;
  const scrollRef = useRef<T>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const autoScroll = useRef(true);

  const atBottom = useCallback(
    (el: HTMLElement) => Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight) <= offset,
    [offset],
  );

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
    autoScroll.current = true;
    setIsAtBottom(true);
    onAtBottomChange?.(true);
  }, [onAtBottomChange]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = atBottom(el);
    autoScroll.current = bottom;
    setIsAtBottom(bottom);
    onAtBottomChange?.(bottom);
  }, [atBottom, onAtBottomChange]);

  // Re-pin to bottom when new content arrives, unless the user has scrolled away.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !autoScroll.current) return;
    requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
    });
  }, [dep]);

  // Re-pin when the container itself RESIZES while we're following — a shrinking viewport (the keys
  // dock opening above the composer, or the on-screen keyboard) pushes the tail below the fold, so
  // stickiness must snap it back. Keyed on the captured `autoScroll` intent, NOT a recomputed
  // at-bottom (the shrink already moved the view off bottom); a scrolled-up user is left in place.
  // Guarded for jsdom, which has no ResizeObserver.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (!autoScroll.current) return;
      el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { scrollRef, isAtBottom, scrollToBottom, onScroll };
}
