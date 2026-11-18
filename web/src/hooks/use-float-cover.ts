import { useEffect, useState, useSyncExternalStore } from "react";

import { useAnySheetOpen } from "@/components/ui/sheet";
import { aHoldIsActive, subscribeHold } from "@/lib/hold-flag";
import { FLOAT_COVER } from "@/lib/tricks/float";
import { useKeyboardOpen, useTypingFocus } from "@/hooks/use-keyboard";

// WHAT HIDES THE FLOATING PICTURES (the `float` place, lib/tricks/float.ts). A picture is never over a
// question, so it is hidden while any of these is true, and comes back when they are all false:
//
//   - a bottom sheet is open (`useAnySheetOpen`), or any dialog is in the page (`role="dialog"`);
//   - a card that asks is on the screen: the card dock (a question, a permission, a plan, a prompt), the ask
//     card, a Hill card, the cannot-tell card, or a session's agent view (`FLOAT_COVER`);
//   - a field that types has focus, or the soft keyboard is up, so the composer is being used;
//   - a finger holds a yes (lib/hold-flag.ts).
//
// The page is read from its DOM: the sheets and cards are drawn all over the app and share no ancestor, so
// one observer on the document answers for all of them. It looks for the selectors only when a node is
// added or removed, once a frame at most.

const COVER_SELECTOR = FLOAT_COVER.join(",");

/** Whether any element of the cover list is in the document now. */
export function coverInDocument(doc: Document = document): boolean {
  return doc.querySelector(COVER_SELECTOR) !== null;
}

function useCoverInDom(): boolean {
  const [covered, setCovered] = useState<boolean>(() => coverInDocument());
  useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      setCovered(coverInDocument());
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(read);
    };
    read();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, []);
  return covered;
}

/** Whether a floating picture must be hidden now. */
export function useFloatCover(): boolean {
  const sheet = useAnySheetOpen();
  const dom = useCoverInDom();
  const typing = useTypingFocus();
  const keyboard = useKeyboardOpen();
  const hold = useSyncExternalStore(subscribeHold, aHoldIsActive, () => false);
  return sheet || dom || typing || keyboard || hold;
}

function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

/** Whether the page is visible. A hidden page runs no floating picture (issue 748). */
export function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== "hidden",
    () => true,
  );
}

const REDUCED = "(prefers-reduced-motion: reduce)";

function subscribeReduced(listener: () => void): () => void {
  const query = window.matchMedia?.(REDUCED);
  query?.addEventListener("change", listener);
  return () => query?.removeEventListener("change", listener);
}

/** Whether the system asks for reduced motion. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReduced,
    () => window.matchMedia?.(REDUCED).matches === true,
    () => true,
  );
}
