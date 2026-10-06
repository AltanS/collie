// The one `navigate` this shell calls: remix/component's, always with `resetScroll: false`.
//
// WHY. The Shell never scrolls the window (`h-(--app-h) overflow-hidden`); every route scrolls an
// inner element and keeps its own memory (lib/scroll.ts, screen/follow.ts). With `resetScroll`
// left on, the runtime still guards a window scroll that never happens: on each back or forward it
// reads `documentElement.scrollHeight` (a forced layout) and swaps a `min-height !important`
// stylesheet into `document.adoptedStyleSheets` until the transition ends, and on each push and
// replace in Chromium it adds and removes an `overflow-anchor` sheet (remix `navigation.ts`, the
// scroll style workarounds; research note 06, item 1). With it off the runtime passes
// `scroll: "manual"` and does none of that.
//
// A back or forward move reads `resetScroll` from the state of the entry it lands on, so every entry
// this shell pushes carries `false`, and `quietCurrentEntry` rewrites the first entry, which the
// runtime stamps `true` when it starts. Internal `<a>` links carry `data-rmx-reset-scroll="false"`.
import { navigate as runtimeNavigate } from "remix/component";

type Options = NonNullable<Parameters<typeof runtimeNavigate>[1]>;

/** Navigate in-page; `resetScroll` is always off (see the header). */
export function navigate(href: string, options: Omit<Options, "resetScroll"> = {}): Promise<void> {
  return runtimeNavigate(href, { ...options, resetScroll: false });
}

/**
 * Turn `resetScroll` off on the entry on screen. Call after the runtime starts (main.tsx), which
 * stamps the current entry with `resetScroll: true`; a later back move onto it reads that stamp.
 */
export function quietCurrentEntry(): void {
  const nav = window.navigation;
  const state: unknown = nav?.currentEntry?.getState();
  if (nav === undefined || !(state instanceof Object) || !("$rmx" in state)) return;
  if ("resetScroll" in state && state.resetScroll === false) return;
  nav.updateCurrentEntry({ state: { ...state, resetScroll: false } });
}
