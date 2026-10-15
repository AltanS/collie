// THE MARK CONTRACT (M57 spec 09). Every mark a theme can name implements these props, and nothing
// else. The header, the boot splash, the idle cover, the agent start and the tour mount a mark through
// `<ThemeMark/>` (components/theme-mark.tsx), which picks the component from the static registry in
// `./index.ts` by the active theme's `mark`.
//
// What a mark renders:
//
// - ONE inline `<svg>` of `size` by `size` and no other DOM: no wrapper, no sibling. The size box and
//   the 44px tap target belong to the call site (collie-home.tsx), never to the mark.
// - `role="presentation"` without `title`, `role="img"` with it, and the `title` text as its
//   `<title>`. The dog is the one exception: its adapter keeps what the generated `collie-mark.tsx`
//   draws (the name on `aria-label`), because that file is hash-sealed and its DOM must not move.
//   No call site passes a title today; the header's name is on its button.
// - Three states and only three. A theme never changes what a state means:
//   - `idle`: connected and at rest.
//   - `loading`: something is fetching, or the connection has been in trouble for a sustained beat.
//   - `lost`: the connection is given up on. The mark is still and reads as asleep.
//   Every mark takes all three. The state is derived at the call site from the booleans that were
//   there before; the mark only draws it.
// - CSS only: the motion is CSS keyframes on elements inside the `<svg>`, inside the mark's own
//   `<style>`. No script timer, no image, no network, no dynamic import.
// - `@media (prefers-reduced-motion: reduce)` stops every animated element; `loading` must still read
//   as different from `idle` without motion (the dog does it with colour).
//
// THE RATE RAMP. collie-home.tsx speeds one "round" of the loading motion up and down by calling
// `updatePlaybackRate` on the animations it collects from the header box with
// `getAnimations({ subtree: true })`, keeping those whose `animationName` starts with `cm-`. It is
// written against that DOM, not against the dog. So a mark that animates with CSS keyframes on
// elements inside its `<svg>`, with animation names that start with `cm-`, is ramped the same way. A
// mark whose names do not start with `cm-` is simply not ramped; it is never an error.

export type MarkState = "idle" | "loading" | "lost";

export interface MarkProps {
  /** Rendered width and height, in pixels. */
  size?: number;
  /** Which of the three states to draw. Defaults to `idle`. */
  state?: MarkState;
  /** The colour the mark sits on, for any knockout it draws. A CSS colour, usually a token. */
  paper?: string;
  /** An accessible name. Without one the mark is decorative. */
  title?: string;
  /** Forwarded to the `<svg>`. */
  className?: string;
  /** `header` below about 80px, `full` above. A mark with one drawing may draw it for both. */
  weight?: "full" | "header";
}
