// Module-level scroll position memory, keyed by a caller-chosen string.
//
// Why this exists: `screen-transition.tsx` remounts the routed subtree with a fresh `key` on every
// dashboard<->pane move (both directions, see its `seen.mounts` key), so the dashboard's own
// scroller (home.tsx's inner `overflow-y-auto` div — the document itself never scrolls, root.tsx is
// `h-[100dvh] overflow-hidden`) is a brand-new DOM node with `scrollTop` 0 every time you come back
// from a pane. `<ScrollRestoration>` restores window scroll and would not help here even if wired up.
//
// In-memory only, no sessionStorage: a full page load must start at the top, and this state is
// same-tab, same-session by design — closing the tab or reloading forgets it on purpose.
const positions = new Map<string, number>();

/** Record the current scroll position for `key`. */
export function rememberScroll(key: string, top: number): void {
  positions.set(key, top);
}

/** The last remembered scroll position for `key`, or `undefined` if none was recorded yet. */
export function recallScroll(key: string): number | undefined {
  return positions.get(key);
}
