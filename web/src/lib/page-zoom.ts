// Stops a pinch from zooming the whole page, while the device's Pinch to zoom setting is off
// (DashPrefs.pageZoom). ON by default: the browser's own zoom is how a person makes text bigger, and
// 0.2.x put it back (`maximum-scale=1` removed) for that reason. Off is for a person who keeps zooming
// the app by accident.
//
// The viewport meta cannot do this: iOS Safari has ignored `user-scalable=no` and `maximum-scale` since
// iOS 10, in a tab and from the home screen. Two things are used instead, and each covers what the
// other cannot.
//
//   · A cancelled `gesturestart` (Safari's own pinch event) and a cancelled two-finger `touchmove`.
//     That covers iOS, and Chrome on Android for a pinch that starts with both fingers down.
//   · `touch-action: pan-x pan-y` on the root (index.css, `html[data-page-zoom-off]`). Chrome on Android
//     lets a `touchmove` be cancelled only until a scroll has started: a person who scrolls with one
//     finger and then adds a second gets a `touchmove` that is not cancelable, and the guard above
//     cannot stop that pinch. The browser reads `touch-action` for it instead. One finger still pans
//     in both axes, so scrolling is unchanged.
//
// One finger is never touched by the guard, so scrolling, selecting and the two-finger pane gesture's
// own listeners (ADR 0121) behave as before. None of the other zoom features rides on the browser's
// pinch: the Screen view's zoom (components/output-zoom.tsx) and the picture zoom
// (components/ui/zoom-picture.tsx) read their own touches and already set `pan-x pan-y` on their box,
// and the pane gesture arms by a hold and a second finger, then vetoes `touchmove` itself.
//
// THE SETTING IS KEPT HERE, NOT READ PER EVENT. A pinch fires `touchmove` about sixty times a second,
// and reading the prefs from storage on each one parsed the whole blob. The value lives in this
// module: the page reads it once at start (`installPageZoom`), the Settings switch tells it at once
// (`setPageZoomAllowed`), and another tab's change arrives as a `storage` event. A change takes effect
// at the next pinch without a reload.

/** The attribute on `<html>` while a pinch must not zoom the page; index.css hangs `touch-action` on it. */
export const PAGE_ZOOM_OFF_ATTR = "data-page-zoom-off";

let allowed = true;

/** Whether a pinch may zoom the page right now. */
export function pageZoomAllowed(): boolean {
  return allowed;
}

/** Take the setting: the guard's answer changes now, and the root's attribute follows it. */
export function setPageZoomAllowed(on: boolean, doc: Document = document): void {
  allowed = on;
  doc.documentElement.toggleAttribute(PAGE_ZOOM_OFF_ATTR, !on);
}

export function installPageZoomGuard(target: Document, isAllowed: () => boolean = pageZoomAllowed): () => void {
  const stop = (e: Event) => {
    if (e.cancelable && !isAllowed()) e.preventDefault();
  };
  const stopPinch = (e: TouchEvent) => {
    if (e.touches.length > 1) stop(e);
  };
  target.addEventListener("gesturestart", stop, { passive: false });
  target.addEventListener("touchmove", stopPinch, { passive: false });
  return () => {
    target.removeEventListener("gesturestart", stop);
    target.removeEventListener("touchmove", stopPinch);
  };
}

/**
 * Start the guard for this page: read the setting once with `read`, keep the root's attribute in step
 * with it, and read it again when another tab changes storage. Returns the uninstall.
 */
export function installPageZoom(read: () => boolean, doc: Document = document, win: Window = window): () => void {
  setPageZoomAllowed(read(), doc);
  const uninstallGuard = installPageZoomGuard(doc);
  const onStorage = () => setPageZoomAllowed(read(), doc);
  win.addEventListener("storage", onStorage);
  return () => {
    uninstallGuard();
    win.removeEventListener("storage", onStorage);
    setPageZoomAllowed(true, doc);
  };
}
