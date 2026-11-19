import { useEffect, useState, type RefObject } from "react";

import { hasResizeObserver } from "@/lib/env";
import { FLOAT_LANDMARKS, perchReach, safeRegion, sameBox, visibleBox, type Box, type FloatScreen, type Insets } from "@/lib/tricks/float";

// THE SAFE REGION OF A SCREEN, READ FROM THE PAGE (lib/tricks/float.ts holds the maths).
//
// The inputs are the visual viewport (so the soft keyboard counts), the safe-area insets, and the boxes of
// Collie's landmarks on this screen (`FLOAT_LANDMARKS`, found by `data-slot`). Each landmark is watched with
// a ResizeObserver, and the list is found again whenever a node is added or removed. A change of the viewport,
// a scroll (a landmark that sits in a scrolling list moves), a resize or a turn measures again. A scroll
// waits until it has stopped, so a picture glides once to its new place after a scroll and does not chase it.
// A measure is taken once a frame at most, and the region is the same object while it did not change.
//
// `probe` is an element that carries the safe-area insets as padding (`env(safe-area-inset-*)`), read here.

const SCROLL_SETTLE_MS = 150;

function px(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function insetsOf(probe: HTMLElement | null): Insets {
  if (probe === null) return { top: 0, right: 0, bottom: 0, left: 0 };
  const style = getComputedStyle(probe);
  return { top: px(style.paddingTop), right: px(style.paddingRight), bottom: px(style.paddingBottom), left: px(style.paddingLeft) };
}

function viewportBox(): Box {
  const vv = window.visualViewport;
  if (vv === null) return { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
  return { x: vv.offsetLeft, y: vv.offsetTop, w: vv.width, h: vv.height };
}

export interface Landmarks {
  boxes: Box[];
  elements: Element[];
}

/**
 * The landmarks of `screen` on the page, and the boxes of those that take room. A landmark with nothing in it
 * is a slot that is waiting (the notice slot above the composer holds only its own padding until a notice comes):
 * it is watched, so its filling is measured, but its padding is no room, and a picture that stands on the edge
 * above it must stand on what is really there. A box with no area takes no room either.
 */
export function landmarkBoxes(screen: FloatScreen): Landmarks {
  const elements = FLOAT_LANDMARKS[screen].flatMap((selector) => Array.from(document.querySelectorAll(selector)));
  const boxes = elements
    .filter((element) => element.childNodes.length > 0)
    .map((element): Box => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
    });
  return { boxes, elements };
}

/** The free area of a screen, and how far a perched picture may reach on each edge of it (up to the landmark, with no gap). */
export interface FloatSpace {
  region: Box;
  reach: Box;
}

function sameSpace(a: FloatSpace | null, b: FloatSpace | null): boolean {
  if (a === null || b === null) return a === b;
  return sameBox(a.region, b.region) && sameBox(a.reach, b.reach);
}

/** The safe region of `screen` now, or null when there is no screen, `enabled` is off, or no room is left. */
export function useFloatRegion(screen: FloatScreen | null, enabled: boolean, probe: RefObject<HTMLElement | null>): FloatSpace | null {
  const [region, setRegion] = useState<FloatSpace | null>(null);
  useEffect(() => {
    if (!enabled || screen === null) {
      setRegion(null);
      return;
    }
    let frame = 0;
    let settle: ReturnType<typeof setTimeout> | undefined;
    let watched: Element[] = [];
    const resizes = hasResizeObserver() ? new ResizeObserver(() => schedule()) : null;
    const measure = () => {
      frame = 0;
      const { boxes, elements } = landmarkBoxes(screen);
      if (resizes !== null && (elements.length !== watched.length || elements.some((element, i) => element !== watched[i]))) {
        resizes.disconnect();
        for (const element of elements) resizes.observe(element);
        watched = elements;
      }
      const viewport = viewportBox();
      const insets = insetsOf(probe.current);
      const free = safeRegion({ viewport, insets, landmarks: boxes });
      const next = free === null ? null : { region: free, reach: perchReach(free, visibleBox(viewport, insets)) };
      setRegion((had) => (sameSpace(had, next) ? had : next));
    };
    function schedule() {
      if (frame === 0) frame = requestAnimationFrame(measure);
    }
    const onScroll = () => {
      clearTimeout(settle);
      settle = setTimeout(schedule, SCROLL_SETTLE_MS);
    };
    measure();
    const vv = window.visualViewport;
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { childList: true, subtree: true });
    vv?.addEventListener("resize", schedule);
    vv?.addEventListener("scroll", onScroll);
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      clearTimeout(settle);
      resizes?.disconnect();
      mutations.disconnect();
      vv?.removeEventListener("resize", schedule);
      vv?.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      document.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [screen, enabled, probe]);
  return region;
}
