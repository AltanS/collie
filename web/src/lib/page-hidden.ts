/**
 * A HIDDEN PAGE RUNS NO ANIMATION (issue 748, ADR 0138).
 *
 * While `document.visibilityState` is `hidden`, `<html>` carries `data-page-hidden`, and one rule in
 * `index.css` pauses every CSS animation under it, pseudo-elements included. A paused animation
 * resumes where it stopped, so coming back shows exactly what was left.
 *
 * Why, when a browser draws nothing for a hidden page anyway: "hidden" is the page's own report, and
 * an installed app on a phone is often still composited while it says so (the task switcher, a
 * split screen, a window going away). On the phone that issue 748 is about, every running animation
 * kept the GPU process allocating buffers, and the system killed the whole browser for it. A paused
 * animation asks for no frame at all, whatever the browser does with the page.
 *
 * The JavaScript that drives a visual stops on its own already: `requestAnimationFrame` does not run
 * for a hidden page, the poll and the cache clock stop on this same event (`hooks/use-polling.ts`,
 * `lib/cache-clock.ts`), and the header's spin round is a single bounded turn.
 */
export const PAGE_HIDDEN_ATTR = "data-page-hidden";

/** Keep the attribute in step with the page's visibility, from now on. Returns the uninstall. */
export function installHiddenPause(doc: Document = document): () => void {
  const sync = () => {
    doc.documentElement.toggleAttribute(PAGE_HIDDEN_ATTR, doc.visibilityState === "hidden");
  };
  sync();
  doc.addEventListener("visibilitychange", sync);
  return () => doc.removeEventListener("visibilitychange", sync);
}
