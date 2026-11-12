// Stops a pinch from zooming the whole page, while the device's Pinch to zoom setting is off
// (DashPrefs.pageZoom). ON by default: the browser's own zoom is how a person makes text bigger, and
// 0.2.x put it back (`maximum-scale=1` removed) for that reason. Off is for a person who keeps zooming
// the app by accident.
//
// The viewport meta cannot do this: iOS Safari has ignored `user-scalable=no` and `maximum-scale` since
// iOS 10, in a tab and from the home screen. What it honours is a cancelled `gesturestart` (Safari's
// own pinch event) and a cancelled two-finger `touchmove`, which also covers Chrome on Android. One
// finger is never touched, so scrolling, selecting and the two-finger pane gesture's own listeners
// (ADR 0121) behave as before. The Screen view's zoom (components/output-zoom.tsx) runs its own pinch
// and cancels the browser's on its viewport, so it works the same with this on or off.
//
// `allowed` is asked on every gesture rather than once, so a change in Settings takes effect at the
// next pinch without a reload.

export function installPageZoomGuard(target: Document, allowed: () => boolean): () => void {
  const stop = (e: Event) => {
    if (e.cancelable && !allowed()) e.preventDefault();
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
