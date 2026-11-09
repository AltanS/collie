// THE APP'S HEIGHT AFTER A RETURN FROM THE BACKGROUND, pinned to what the glass shows.
//
// `--app-h` is `100dvh` on Android (index.css), and the app's column is `h-(--app-h)` with a
// `shrink-0` bottom region, so a column taller than the glass paints its last row, the composer,
// past the bottom edge. The owner's report (2026-11-07): an installed Android PWA, opened again after
// a long break, drew the Chat view about one composer box too tall with the keyboard down, and only a
// hard refresh brought the box back. The likely cause is a stale viewport after Android restored the
// frozen page: the layout height (`innerHeight`, and `dvh` with it) kept a value the visual viewport
// no longer has, and nothing re-laid the page until a resize fired. build-stamp.tsx's dev-only stamp
// was added for an earlier sighting of the same shape, a layout viewport taller than the screen.
//
// So on each return to the foreground (`visibilitychange` to visible, `pageshow`, `focus`) this reads
// both heights, and when they disagree by more than a few pixels it sets `--app-h` on <html> to the
// visual viewport's height in pixels. The inline value beats the stylesheet's `:root` rule, so every
// `h-(--app-h)` surface takes it at once. The pin holds until the next real window `resize`, then it
// is removed and the CSS value is back in charge: a real resize means the browser has measured again.
// The return also arms ONE check on the next visual-viewport `resize`, for a browser that delivers
// the stale reading a moment after the page is shown rather than at once.
//
// NOT ON iOS. An iOS home-screen launch has its own token for two WebKit bugs that pull in opposite
// directions (index.css), and one of them makes the visual height short of the right one by the
// status bar. Pinning to it there would bring back the dead band #355 fixed.
//
// NOT WHILE ZOOMED. A pinch zoom shrinks the visual viewport on purpose, and the page must not follow.
//
// Each pin logs one line with the four heights that tell the cases apart, through the app's
// `console.info("collie: …")` channel. It fires only when the disagreement is there, so a healthy
// device never prints it.

/** Below this many pixels the two heights agree: sub-pixel rounding and a 1px hairline are not a bug. */
export const PIN_SLACK_PX = 4;

/** What one look at the window reads. Pure data, so the decision below is testable without a browser. */
export interface ViewportReading {
  readonly innerHeight: number;
  readonly visualHeight: number;
  readonly scale: number;
  /** `--app-h` as laid out, measured on a probe; null where layout gives no height (jsdom). */
  readonly appHeight: number | null;
}

/** The height to pin `--app-h` to, in whole pixels, or null when the page already fits the glass. Pure. */
export function pinTarget(r: ViewportReading): number | null {
  if (!(r.visualHeight > 0)) return null;
  if (Math.abs(r.scale - 1) > 0.01) return null;
  const innerOff = Math.abs(r.innerHeight - r.visualHeight) > PIN_SLACK_PX;
  const appOff = r.appHeight !== null && Math.abs(r.appHeight - r.visualHeight) > PIN_SLACK_PX;
  return innerOff || appOff ? Math.round(r.visualHeight) : null;
}

/** True on WebKit's touch builds, where index.css swaps `--app-h` for the iOS home-screen token. */
function isIosWebKit(): boolean {
  // jsdom has no `CSS.supports`, hence the optional calls.
  return globalThis.CSS?.supports?.("-webkit-touch-callout", "none") === true;
}

/** `--app-h` as the stylesheet lays it out, on a probe that is in the page for one read. */
function measureAppHeight(doc: Document): number | null {
  const probe = doc.createElement("div");
  probe.style.cssText = "position:fixed;top:0;left:0;width:0;height:var(--app-h);visibility:hidden;pointer-events:none";
  doc.body.appendChild(probe);
  const height = probe.getBoundingClientRect().height;
  probe.remove();
  return height > 0 ? height : null;
}

/**
 * Starts watching for a return to the foreground. Returns the stop function, which also removes a
 * pin that is still on. Call once, before the first render.
 */
export function startViewportPin(win: Window = window): () => void {
  const doc = win.document;
  const root = doc.documentElement;
  if (isIosWebKit()) return () => {};

  let pinned: number | null = null;
  let armed = false;

  const release = () => {
    if (pinned === null) return;
    pinned = null;
    root.style.removeProperty("--app-h");
  };

  const check = () => {
    const vv = win.visualViewport;
    if (!vv) return;
    const target = pinTarget({
      innerHeight: win.innerHeight,
      visualHeight: vv.height,
      scale: vv.scale,
      // While pinned the probe would read the pin back, so only the layout height speaks then.
      appHeight: pinned === null ? measureAppHeight(doc) : null,
    });
    if (target === null || target === pinned) return;
    pinned = target;
    root.style.setProperty("--app-h", `${target}px`);
    console.info(
      `collie: viewport re-pinned inner=${win.innerHeight} visual=${Math.round(vv.height)} client=${root.clientHeight} scrollY=${Math.round(win.scrollY)}`,
    );
  };

  const onForeground = () => {
    if (doc.visibilityState !== "visible") return;
    check();
    armed = true;
  };
  const onVisualResize = () => {
    if (!armed) return;
    armed = false;
    check();
  };

  doc.addEventListener("visibilitychange", onForeground);
  win.addEventListener("pageshow", onForeground);
  win.addEventListener("focus", onForeground);
  win.addEventListener("resize", release);
  win.visualViewport?.addEventListener("resize", onVisualResize);
  return () => {
    doc.removeEventListener("visibilitychange", onForeground);
    win.removeEventListener("pageshow", onForeground);
    win.removeEventListener("focus", onForeground);
    win.removeEventListener("resize", release);
    win.visualViewport?.removeEventListener("resize", onVisualResize);
    release();
  };
}
