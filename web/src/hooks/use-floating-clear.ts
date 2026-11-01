import { useLayoutEffect, useState } from "react";

import { hasResizeObserver } from "@/lib/env";

export function useFloatingClear(slot: HTMLElement | null): number {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    if (slot === null) return;
    const measure = () => setHeight(slot.firstElementChild === null ? 0 : Math.ceil(slot.getBoundingClientRect().height));
    measure();
    const mo = new MutationObserver(measure);
    mo.observe(slot, { childList: true });
    if (!hasResizeObserver()) return () => mo.disconnect();
    const ro = new ResizeObserver(measure);
    ro.observe(slot);
    return () => {
      mo.disconnect();
      ro.disconnect();
    };
  }, [slot]);
  return height;
}
