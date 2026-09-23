// THE GLIDE FROM A CHANGES TAB ROW INTO ITS SCREEN (dashboard → `/space/:id/changes`).
//
// The tapped row's workspace label and its count line move into the Changes screen's header, where
// the same label and the same count line sit (ChangesRoute, `data-glide` inside the header row);
// the rest of the screen and the header row crossfade. 250ms, ease-out, transform and opacity only,
// all of it in the browser's own view-transition layer (index.css, `html.changes-glide`).
//
// OURS, NOT REACT ROUTER'S. The app keeps React Router's `viewTransition` flag off for good
// (screen-transition.tsx, router.tsx): the router remembers every path it once animated and replays
// a phantom transition on every revalidation of it. This calls `document.startViewTransition` once,
// by hand, around one navigation, and the router never learns a transition happened, so nothing is
// remembered and a poll can never replay it. `:root` stays unnamed, as index.css requires, so only the
// parts named here are captured; anything else would swap in place under them.
//
// WHEN IT DOES NOT RUN, the tap simply navigates, as before:
//   · the browser has no `document.startViewTransition` (Safari before 18, older engines);
//   · the reader asked for reduced motion;
//   · any move other than this one tap. It is started from the row's click and from nowhere else, so
//     a POP (the iOS edge swipe, a browser back) never meets it and shows only the phone's own
//     animation (ADR 0067), and the header's back arrow does not glide the numbers back down.
// ScreenTransition's slide covers dashboard ↔ pane only, so this pair of screens never gets both.

/** The two names the pair shares. The row gets them inline; the header gets them from index.css. */
const PARTS = [
  { part: "label", name: "changes-glide-label" },
  { part: "count", name: "changes-glide-count" },
] as const;
/** On `<html>` for the life of one transition; index.css scopes every name and timing under it. */
export const GLIDE_CLASS = "changes-glide";
/** How long the new screen may take to put its header up before the transition goes without it. */
const ARRIVE_TIMEOUT_MS = 400;
/** The element the arriving header draws, which says the new screen is in the DOM. */
const ARRIVED = '[data-slot="header-row"] [data-glide="label"]';

/** Whether a tap would glide here: the API exists and the reader has not asked for less motion. */
export function canGlide(): boolean {
  if (!("startViewTransition" in document)) return false;
  return !(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
}

/**
 * Resolves once the Changes header is in the DOM, or after {@link ARRIVE_TIMEOUT_MS}. The route has
 * no loader, but the router still commits the new screen a task or two after `navigate()`, and the
 * transition must not take its "after" picture before that. A MutationObserver rather than a frame
 * wait, because the browser renders no frames while a transition's update callback is pending.
 */
function arrived(): Promise<void> {
  if (document.querySelector(ARRIVED) !== null) return Promise.resolve();
  let observer: MutationObserver | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const seen = new Promise<void>((resolve) => {
    observer = new MutationObserver(() => {
      if (document.querySelector(ARRIVED) !== null) resolve();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ARRIVE_TIMEOUT_MS);
  });
  return Promise.race([seen, late]).finally(() => {
    observer?.disconnect();
    clearTimeout(timer);
  });
}

/**
 * Navigate with `go`, gliding the row's `[data-glide]` parts into the new header when the browser
 * can. `from` is the tapped row's button.
 */
export function glideInto(from: HTMLElement, go: () => void): void {
  if (!canGlide()) {
    go();
    return;
  }
  const parts = PARTS.flatMap(({ part, name }) => {
    const el = from.querySelector<HTMLElement>(`[data-glide="${part}"]`);
    return el ? [{ el, name }] : [];
  });
  const root = document.documentElement;
  const clean = () => {
    root.classList.remove(GLIDE_CLASS);
    for (const { el } of parts) el.style.viewTransitionName = "";
  };
  for (const { el, name } of parts) el.style.viewTransitionName = name;
  root.classList.add(GLIDE_CLASS);
  let transition: ViewTransition;
  try {
    transition = document.startViewTransition(async () => {
      go();
      await arrived();
    });
  } catch {
    clean();
    go();
    return;
  }
  // A skipped transition (a duplicate name, a hidden page) still ran `go`; only the motion is lost.
  transition.ready.catch(() => {});
  void transition.finished.then(clean, clean);
}
