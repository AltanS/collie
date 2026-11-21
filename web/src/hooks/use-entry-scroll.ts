import { useLayoutEffect, type RefObject } from "react";
import { useLocation } from "react-router";

import { recallScroll, rememberScroll } from "@/lib/scroll-memory";

/** How many frames a restore keeps trying while the page's rows are still arriving (about two seconds). */
export const ENTRY_SCROLL_FRAMES = 120;

/**
 * Keep a page's scroll per HISTORY ENTRY: a step back onto the entry lands where the person left it, and a fresh
 * visit to the same page starts at the top. Keyed on the router's `location.key`, which the browser keeps for
 * the entry, in memory only (`lib/scroll-memory.ts`: a reload starts at the top).
 *
 * A list whose rows arrive after the first frame (Settings, Tricks and the Hill waits for the official list) is shorter than
 * the place to restore, so the restore tries again each frame until it lands, for {@link ENTRY_SCROLL_FRAMES} at
 * most, and stops at once when the person touches, wheels or types: their own scroll wins.
 */
export function useEntryScroll(ref: RefObject<HTMLElement | null>, enabled: boolean): void {
  const { key } = useLocation();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || el === null) return;
    const memo = `entry-scroll:${key}`;
    const target = recallScroll(memo) ?? 0;
    let frame = 0;
    let handle: number | null = null;
    const stop = () => {
      if (handle !== null) cancelAnimationFrame(handle);
      handle = null;
    };
    const step = () => {
      handle = null;
      el.scrollTop = target;
      frame += 1;
      if (Math.abs(el.scrollTop - target) > 1 && frame < ENTRY_SCROLL_FRAMES) handle = requestAnimationFrame(step);
    };
    if (target > 0) step();
    const onScroll = () => rememberScroll(memo, el.scrollTop);
    const onInput = () => stop();
    el.addEventListener("scroll", onScroll, { passive: true });
    for (const kind of ["touchstart", "wheel", "pointerdown", "keydown"] as const) el.addEventListener(kind, onInput, { passive: true });
    return () => {
      stop();
      el.removeEventListener("scroll", onScroll);
      for (const kind of ["touchstart", "wheel", "pointerdown", "keydown"] as const) el.removeEventListener(kind, onInput);
    };
  }, [ref, enabled, key]);
}
