import { useEffect, useState } from "react";

/** The height the person can see, in px: the visual viewport, which shrinks with the keyboard. */
function visibleHeight(): number {
  return window.visualViewport?.height ?? window.innerHeight;
}

/**
 * The visible height, kept current through the visual viewport's resize (the keyboard opening or
 * closing, a rotation) and the window's, for a browser with no visual viewport.
 */
export function useVisibleHeight(): number {
  const [height, setHeight] = useState(visibleHeight);
  useEffect(() => {
    const update = () => setHeight(visibleHeight());
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", update);
    window.addEventListener("resize", update);
    update();
    return () => {
      viewport?.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return height;
}
