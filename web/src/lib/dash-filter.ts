// The Dashboard's session filter: how it is entered, and where its query lives (M97 spec 04).
//
// ── THE ENTRY (README decision 10, a LOOK in the playground round) ──────────────────────────────────
// `button`: a magnifier in the control bar opens the field under it. `always`: the field stands under
// the bar. The list is the same either way. `AgentList` takes it as an optional prop that defaults to
// this constant, so the round can draw both side by side.
//
// ── THE QUERY (README decision 12) ──────────────────────────────────────────────────────────────────
// A module-level store, one entry per host scope (`scopeKey`), read with `useSyncExternalStore`. The
// Dashboard unmounts whenever a session opens (ScreenTransition remounts the route), so component state
// would lose the query on the way to a session and back; a module variable outlives the route and dies
// with the page, which is the lifetime the README asks for: "survives a visit to a session and back, is
// never stored on the device". Nothing here touches `localStorage` or `sessionStorage`.
//
// The entry holds the query and whether the field is open (the `button` entry's second state), so a
// person who comes back finds the field as they left it.

import { useCallback, useSyncExternalStore } from "react";

/** How the Dashboard's filter field is reached. */
export type DashFilterEntry = "button" | "always";

/** The playground round's switch (spec 05): README decision 10. */
export const DASH_FILTER_ENTRY: DashFilterEntry = "button";

/** What the Dashboard holds about its filter, for one host scope. */
export interface DashFilterState {
  /** The typed query. Empty is "no filter": the list renders exactly as it did before the filter existed. */
  readonly query: string;
  /** Whether the `button` entry has the field open. The `always` entry ignores it. */
  readonly open: boolean;
}

/** A state and its two writers: what `AgentList` needs, from the store or from a caller that owns it. */
export interface DashFilterControl extends DashFilterState {
  readonly setQuery: (query: string) => void;
  readonly setOpen: (open: boolean) => void;
}

const CLOSED: DashFilterState = { query: "", open: false };

const states = new Map<string, DashFilterState>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function read(key: string): DashFilterState {
  return states.get(key) ?? CLOSED;
}

function write(key: string, next: DashFilterState): void {
  const was = read(key);
  if (was.query === next.query && was.open === next.open) return;
  if (next.query === "" && !next.open) states.delete(key);
  else states.set(key, next);
  for (const listener of listeners) listener();
}

/** Drop every stored query, as a page load does. For tests. */
export function __resetDashFilter(): void {
  states.clear();
  for (const listener of listeners) listener();
}

/** The filter's state for one host scope (`scopeKey`), and the two ways to change it. */
export function useDashFilter(scopeKey: string): DashFilterControl {
  const state = useSyncExternalStore(
    subscribe,
    () => read(scopeKey),
    () => CLOSED,
  );
  const setQuery = useCallback((query: string) => write(scopeKey, { ...read(scopeKey), query }), [scopeKey]);
  const setOpen = useCallback((open: boolean) => write(scopeKey, { ...read(scopeKey), open }), [scopeKey]);
  return { query: state.query, open: state.open, setQuery, setOpen };
}
