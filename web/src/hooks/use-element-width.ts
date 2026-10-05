import { useLayoutEffect, useState } from "react";

/**
 * The width in CSS pixels of the element handed to the returned callback ref, kept current by a
 * ResizeObserver. `fallback` until the element has been measured, and wherever there is no layout to
 * measure (jsdom reports 0) or no ResizeObserver, so a first render is never empty.
 *
 * It is a callback ref, not a ref object, because the element can come and go: a chart draws a
 * placeholder until its data arrives and its column only then exists. It measures in a layout effect,
 * so the width is known before the first paint and a chart is drawn once at its real width.
 */
export function useElementWidth<T extends HTMLElement>(fallback: number): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(fallback);

  useLayoutEffect(() => {
    if (el === null) return;
    const read = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      // `setState` with the same value draws nothing, so a resize that moves nothing is free.
      if (w > 0) setWidth(w);
    };
    read();
    if (globalThis.ResizeObserver === undefined) return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);

  return [setEl, width];
}
