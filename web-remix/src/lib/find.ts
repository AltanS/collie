// Find in the mirror: the bar's state (open, query, focused hit) as a small store. The matching is
// web's pure `findMatches` (web/src/lib/find.ts, read-only reuse); this module only keeps which hit
// is focused, wraps the steps, and holds the focus in range when the mirror text moves under it.
import { findMatches, type FindMatch } from "@web/lib/find";

import { createStore, type Store } from "./store";

export { findMatches, type FindMatch };

export interface FindState {
  open: boolean;
  query: string;
  /** Index of the focused hit, or 0 when there are none. */
  current: number;
  /** Hits in the text last measured. */
  count: number;
}

const CLOSED: FindState = { open: false, query: "", current: 0, count: 0 };

export interface Find {
  state: Store<FindState>;
  open(): void;
  close(): void;
  setQuery(query: string): void;
  next(): void;
  prev(): void;
  /** Measure `text`: the hits, with the focus clamped into range. Pure; call from render. */
  measure(text: string): { matches: FindMatch[]; current: number };
  /** After the commit: publish the count and the clamped focus the bar shows. */
  report(count: number, current: number): void;
}

/** Step `current` by `delta` over `count` hits, wrapping at both ends. */
export function stepMatch(current: number, count: number, delta: 1 | -1): number {
  if (count === 0) return 0;
  return (current + delta + count) % count;
}

export function createFind(): Find {
  const state = createStore<FindState>(CLOSED);
  let lastText = "";
  let lastQuery = "";
  let lastMatches: FindMatch[] = [];
  return {
    state,
    open: () => state.update((s) => (s.open ? s : { ...CLOSED, open: true })),
    close: () => state.set(CLOSED),
    setQuery: (query) => state.update((s) => ({ ...s, query, current: 0 })),
    next: () => state.update((s) => ({ ...s, current: stepMatch(s.current, s.count, 1) })),
    prev: () => state.update((s) => ({ ...s, current: stepMatch(s.current, s.count, -1) })),
    measure(text) {
      const s = state.get();
      if (!s.open || s.query === "") return { matches: [], current: -1 };
      if (text !== lastText || s.query !== lastQuery) {
        lastText = text;
        lastQuery = s.query;
        lastMatches = findMatches(text, s.query);
      }
      const count = lastMatches.length;
      const current = count === 0 ? 0 : Math.min(s.current, count - 1);
      return { matches: lastMatches, current: count === 0 ? -1 : current };
    },
    report(count, current) {
      const s = state.get();
      const focus = Math.max(0, current);
      if (s.open && (s.count !== count || s.current !== focus)) state.set({ ...s, count, current: focus });
    },
  };
}
