// Reading the Collie mark's state out of the DOM, in one place.
//
// <CollieMark/> has no "running" class to assert on and no second element to look for. Its <style>
// is a module constant shared by every instance on the page (a stylesheet inside an inline SVG is
// document-scoped), so the whole difference between rest and the bloom is a set of CSS custom
// properties on the element itself, plus the `cm-live` class that starts the animation. That is
// where these read it from — and every suite that asks (CollieHome, the header, BootSplash) would
// otherwise spell the same query.
//
// There is no longer a "resting turn" — at rest the mark is a still drawing with no animation
// running at all. `cm-live` is what starts the orbit, and it is only ever present while `loading`.

/**
 * The one <CollieMark/> inside `root`, or `null`. Identified by the inline stylesheet it carries —
 * a lucide icon in the same tree is also an <svg>, and nothing else in the app ships CSS inside one.
 */
export function collieMark(root: ParentNode): SVGSVGElement | null {
  return root.querySelector<SVGSVGElement>("svg:has(> style)");
}

/** Whether the mark's orbit is animating — i.e. it carries the `cm-live` class. */
export function markIsLive(root: ParentNode): boolean {
  return collieMark(root)?.classList.contains("cm-live") ?? false;
}

/**
 * The first accent colour, or `""` if no mark is mounted. The bloom is a COLOUR as well as a speed:
 * the accents come up to full chroma, and that half is the one a reduced-motion reader still gets,
 * because the media query stops the turning and cannot stop a variable.
 */
export function markAccent(root: ParentNode): string {
  return collieMark(root)?.style.getPropertyValue("--cm-a1") ?? "";
}

/** The knockout colour the mark was told to paint with, or `""` if no mark is mounted. */
export function markPaper(root: ParentNode): string {
  return collieMark(root)?.style.getPropertyValue("--cm-paper") ?? "";
}
