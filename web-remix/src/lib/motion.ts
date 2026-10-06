// The ONE door to `@remix-run/ui/animation` (0.12.1, pinned exactly). The package is unstable and
// its changelog is mostly BREAKING entries, so nothing else imports it: an upgrade touches this file
// (REMIX3.md, "Known rough edges"). Only the four helpers the house rules name are re-exported.
//
// The helpers do not check reduced motion (research note 01, section 4). `reducedMotion()` is the
// JS half of rule 10; call it before a spring, a WAAPI call, a view transition or the orbit.
//
// THE MAPPING TO web/ (the React app is the visual reference; every number below is its own).
// The library's presets are named for a perceptual length, not a settle time: `spring("snappy")` is
// declared 200 ms and settles in 350 ms (`spring("snappy").duration`), bouncy 550, smooth 1050. A
// shell that used the preset by name ran 150 ms longer than web/ and on another curve. So:
//
//   web/ (file, motion)                                  here
//   ui/sheet.tsx:217,255,359,394  fade and slide, 200 ms   CSS classes `duration-200 animate-in` (no door)
//   ui/sheet.tsx:193  snap-back `transform 0.2s ease-out`  `MOTION.snapBack` through `snapBackTransition()`
//   ui/sheet.tsx:189  peek-continue 180 ms ease-out        `MOTION.peekContinue`
//   status-area.tsx:61  toast fade 200 ms, easing `ease`   `toastEntrance()` into `animateEntrance`
//   ui/collapse.tsx  grid-rows and opacity, 240 ms ease-out `COLLAPSE_MS`, in `ui/collapse.tsx`
//
// A CSS transition is the right tool where web/ writes one (the curve is the browser's `ease-out`,
// not a spring's `linear(...)` table). For a place that does want a spring, `springSettling(ms)`
// gives one that SETTLES in `ms` (within 25 ms), so its length matches a React duration instead of
// the preset's.
export { animateEntrance, animateExit, animateLayout, spring } from "@remix-run/ui/animation";
import { animateEntrance, spring } from "@remix-run/ui/animation";

/** The app's one height-and-opacity duration (D §1, `ui/collapse.tsx`). The header's notch
 *  handover and the strip band run on it too, so the two halves of one reservation move as one. */
export const COLLAPSE_MS = 240;

/** web/'s own timings, in one place, so a shell file never writes a bare number for them. */
export const MOTION = {
  /** A short pull-down that did not close the sheet returns (ui/sheet.tsx:193). */
  snapBack: { ms: 200, easing: "ease-out" },
  /** The panel continues from where a peek left it (ui/sheet.tsx:189). */
  peekContinue: { ms: 180, easing: "ease-out" },
  /** A toast fades in (status-area.tsx:61: `animate-in fade-in`, whose timing function is `ease`). */
  toastFade: { ms: 200, easing: "ease" },
} as const;

/** True when the operator asked for reduced motion. Read at the moment an animation would start. */
export function reducedMotion(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** The inline `transition` of a sheet snapping back: web/'s `transform 0.2s ease-out`. */
export function snapBackTransition(): string {
  return `transform ${String(MOTION.snapBack.ms)}ms ${MOTION.snapBack.easing}`;
}

/** The inline `transition` of a panel continuing a peek: web/'s `transform 180ms ease-out`. */
export function peekContinueTransition(): string {
  return `transform ${String(MOTION.peekContinue.ms)}ms ${MOTION.peekContinue.easing}`;
}

/** The toast's entrance for `animateEntrance`: web/'s 200 ms `ease` fade, and none under reduced motion. */
export function toastEntrance(): Parameters<typeof animateEntrance>[0] {
  if (reducedMotion()) return false;
  return { opacity: 0, duration: MOTION.toastFade.ms, easing: MOTION.toastFade.easing };
}

const settling = new Map<number, ReturnType<typeof spring>>();

/**
 * A critically damped spring that settles as near `ms` as the library allows (its `.duration`,
 * which is what an exit holds a node for). The library reports the settle time in 50 ms steps, so
 * the answer is within 25 ms of the ask; the perceptual length it takes is searched, never guessed.
 */
export function springSettling(ms: number): ReturnType<typeof spring> {
  const cached = settling.get(ms);
  if (cached !== undefined) return cached;
  let best = spring({ duration: 10, bounce: 0 });
  for (let perceived = 10; perceived <= 2000; perceived += 5) {
    const candidate = spring({ duration: perceived, bounce: 0 });
    if (Math.abs(candidate.duration - ms) < Math.abs(best.duration - ms)) best = candidate;
    if (candidate.duration > ms + 50) break;
  }
  settling.set(ms, best);
  return best;
}
