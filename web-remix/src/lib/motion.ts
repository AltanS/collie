// The ONE door to `@remix-run/ui/animation` (0.12.1, pinned exactly). The package is unstable and
// its changelog is mostly BREAKING entries, so nothing else imports it: an upgrade touches this file
// (REMIX3.md, "Known rough edges"). Only the four helpers the house rules name are re-exported.
//
// The helpers do not check reduced motion (research note 01, section 4). `reducedMotion()` is the
// JS half of rule 10; call it before a spring, a WAAPI call, a view transition or the orbit.
export { animateEntrance, animateExit, animateLayout, spring } from "@remix-run/ui/animation";

/** The app's one height-and-opacity duration (D §1, `ui/collapse.tsx`). The header's notch
 *  handover and the strip band run on it too, so the two halves of one reservation move as one. */
export const COLLAPSE_MS = 240;

/** True when the operator asked for reduced motion. Read at the moment an animation would start. */
export function reducedMotion(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
