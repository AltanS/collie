// One wait both boots and the composer island share: after the browser's first frame, never later
// than a ceiling.
//
// WHY: a WARM load has the entry module cached, so it runs before the first frame, and `run()` (the
// store reads, the hydrating render) held the paint of rows the server had already drawn (round 8:
// first row 207 ms warm against 107 cold at 4x). Two animation frames put the first paint behind us.
// The timer is the ceiling: animation frames do not run in a hidden tab, and a late hydration must not
// wait for one.

/** The longest {@link afterFirstPaint} waits. */
export const FIRST_PAINT_WAIT_MS = 100;

/** Resolves after the browser's next painted frame, and never later than `ceiling` ms. */
export function afterFirstPaint(ceiling: number = FIRST_PAINT_WAIT_MS): Promise<void> {
  const done = Promise.withResolvers<void>();
  const timer = setTimeout(() => done.resolve(), ceiling);
  requestAnimationFrame(() => requestAnimationFrame(() => done.resolve()));
  return done.promise.finally(() => clearTimeout(timer));
}
