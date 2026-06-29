import { useCallback, useEffect, useRef, useState } from "react";

interface UseAutoScrollOptions {
  /** Px distance from the bottom still considered "at bottom". */
  offset?: number;
  smooth?: boolean;
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
  const { offset = 24, smooth = false, dep, onAtBottomChange } = options;
  const scrollRef = useRef<T>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const autoScroll = useRef(true);

  const atBottom = useCallback(
    (el: HTMLElement) => Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight) <= offset,
    [offset],
  );

  const scrollToBottom = useCallback(
    (instant = false) => {
      const el = scrollRef.current;
      if (!el) return;
      el.scrollTo({ top: el.scrollHeight, behavior: instant ? "auto" : smooth ? "smooth" : "auto" });
      autoScroll.current = true;
      setIsAtBottom(true);
      onAtBottomChange?.(true);
    },
    [smooth, onAtBottomChange],
  );

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
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    });
  }, [dep, smooth]);

  return { scrollRef, isAtBottom, scrollToBottom, onScroll };
}
