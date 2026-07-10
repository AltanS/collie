import { flushSync } from "react-dom";
import type { NavigateFunction, NavigateOptions, To } from "react-router";

// Cross-view animation, built on the browser View Transitions API. Two kinds of switch happen in
// Collie: React-state swaps that stay on one route (home dashboard ↔ space drill-in) and real React
// Router navigations (home ↔ pane, settings, …). This module animates both, keying the CSS off a
// `data-vt` attribute on <html> so a forward move slides in from the right, a backward move reverses,
// and a lateral move ("none") just crossfades. See index.css for the keyframes.

export type Direction = "forward" | "backward" | "none";

type VTDocument = Document & {
  __vtGated?: boolean;
};

// Progressive enhancement: only Chromium and Safari 18+ ship the API, and we skip the animation
// entirely under prefers-reduced-motion. The state change always happens — only the motion is gated.
function enabled(): boolean {
  const doc = document as VTDocument;
  if (typeof doc.startViewTransition !== "function") return false;
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// The CSS reads this to pick the slide direction. It's inert when no transition is running (the
// pseudo-elements only exist mid-transition), so a value left over from a prior move never animates
// anything on its own — the next move always re-marks before it starts.
function mark(direction: Direction): void {
  const el = document.documentElement;
  if (direction === "none") delete el.dataset.vt;
  else el.dataset.vt = direction;
}

// Only animate transitions WE initiate. React Router calls `document.startViewTransition` on every
// poll-driven revalidation (see hooks/use-polling.ts) even though nothing navigated — a documented RR
// behaviour. Left alone, each tick crossfades the named `page`/`app-header` snapshot groups: a visible
// blink of the whole list. We can't stop RR making the call, so we gate the *animation*: `viewTransition`
// and `markNavDirection` arm this flag right before our own transition; the patch below stamps
// `html[data-vt-anim]` for armed calls (CSS animates only then) and leaves it off for RR's, whose
// pseudo-elements then fall to `animation: none` (see index.css). The stamp is cleared on finish so a
// leftover direction can't animate a later poll.
let armed = false;

function installGate(): void {
  const doc = document as VTDocument;
  if (doc.__vtGated || typeof doc.startViewTransition !== "function") return;
  doc.__vtGated = true;
  const native = doc.startViewTransition.bind(doc);
  doc.startViewTransition = ((cb) => {
    const root = document.documentElement;
    if (!armed) {
      delete root.dataset.vtAnim; // an RR revalidation transition — let it swap instantly, no animation
      return native(cb);
    }
    armed = false;
    root.dataset.vtAnim = "";
    const transition = native(cb);
    transition.finished.finally(() => {
      delete root.dataset.vtAnim;
      delete root.dataset.vt;
    });
    return transition;
  }) as typeof doc.startViewTransition;
}

installGate();

/**
 * Animate a *local* view switch — one driven by React state on a single route, e.g. the home
 * dashboard ↔ space drill-in. `flushSync` forces the new view to commit to the DOM inside the
 * transition callback so the API captures the correct "after" frame. No-ops to a plain call when
 * the API is missing or the user prefers reduced motion.
 */
export function viewTransition(direction: Direction, update: () => void): void {
  if (!enabled()) {
    update();
    return;
  }
  mark(direction);
  armed = true;
  (document as VTDocument).startViewTransition!(() => flushSync(update));
}

/**
 * Mark the direction for an imminent React-Router navigation done with `viewTransition: true`
 * (Router owns the transition; we only tell the CSS which way to slide). Returns whether the
 * transition will actually run, so a `<Link>` caller can decide. Always safe to call.
 */
export function markNavDirection(direction: Direction): boolean {
  if (!enabled()) return false;
  mark(direction);
  armed = true;
  return true;
}

/** Navigate with a directional view transition. Falls back to a plain navigation when transitions
 *  are unavailable, so call sites don't have to branch. */
export function navigateWithTransition(
  navigate: NavigateFunction,
  to: To,
  direction: Direction,
  options?: NavigateOptions,
): void {
  if (markNavDirection(direction)) {
    navigate(to, { ...options, viewTransition: true });
  } else {
    navigate(to, options);
  }
}
