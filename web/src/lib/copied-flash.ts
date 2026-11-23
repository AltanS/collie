// A COPY SHOWS WHAT IT COPIED (2026-11-23). After a copy that worked, the thing that was copied carries `data-copied`
// for FLASH_MS: a tint that is there at once and fades out (index.css, `[data-copied]`). Colour only: the tint is an
// overlay that takes no pointer and no space, so no box moves, and nothing takes the focus. One helper sets and clears
// the attribute, so every copy of the app uses the same code. A failed copy never calls it.

/** How long `data-copied` stays: the fade in index.css runs the same time, and a reduced-motion tint holds this long. */
export const FLASH_MS = 700;

const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

/**
 * Flash `target`: set `data-copied` now, clear it after {@link FLASH_MS}. A second copy of the same target restarts
 * the fade from full strength. `null` (the thing copied is not on the page) does nothing.
 */
export function flashCopied(target: Element | null): void {
  if (target === null) return;
  const pending = timers.get(target);
  if (pending !== undefined) {
    clearTimeout(pending);
    // Off and on again with a layout read between, so the CSS animation starts over.
    target.removeAttribute("data-copied");
    target.getBoundingClientRect();
  }
  target.setAttribute("data-copied", "");
  timers.set(
    target,
    setTimeout(() => {
      timers.delete(target);
      target.removeAttribute("data-copied");
    }, FLASH_MS),
  );
}
