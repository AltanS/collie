// The render window of the History view, as pure functions (web/src/routes/history.tsx).
//
// FETCH ALL, RENDER SOME. The whole conversation arrives in one request (1500 turns is 1.3 MB raw,
// 335 KB gzipped), which is what makes find and jump-to-user-message work across turns not yet scrolled
// to. What is NOT cheap is the DOM: 1425 turns at once is ~17k nodes. So the rendered window starts
// small and grows upward as the reader scrolls; the data is already in memory, so growing it is instant.
import type { TranscriptEntry } from "@web/lib/types";

/** Turns rendered on open: a few screens, so first paint stays instant on the longest threads. */
export const INITIAL_RENDER = 60;
/** Turns added per upward growth step. */
export const RENDER_STEP = 120;
/** Distance from the top of the scroller that triggers growth, in px. */
export const GROW_THRESHOLD = 800;
/** Turns requested when the view opens: "show entire history" taken literally (longest measured: 3244). */
export const HISTORY_PAGE_SIZE = 5000;

/**
 * Every turn the view holds, oldest first. A turn the agent REWOUND PAST is not part of this
 * conversation any more, so it is not part of this view, this find or this jump either. The array's
 * identity is kept for every session that never forked, which is almost all of them.
 */
export function heldEntries(older: readonly TranscriptEntry[], first: TranscriptEntry[]): TranscriptEntry[] {
  const all = older.length > 0 ? [...older, ...first] : first;
  return all.some((e) => e.abandoned === true) ? all.filter((e) => e.abandoned !== true) : all;
}

/** The newest `count` turns: what is drawn. */
export function visibleEntries(entries: TranscriptEntry[], count: number): TranscriptEntry[] {
  return count >= entries.length ? entries : entries.slice(entries.length - count);
}

/** One growth step over what is already in memory, never past the total held. */
export function grownCount(count: number, held: number): number {
  return Math.min(count + RENDER_STEP, held);
}

/** How many newest turns must be drawn for `index` (into `held`) to exist, with a little context above it. */
export function countToReach(index: number, held: number, current: number): number {
  const needed = held - index + 10;
  return Math.max(current, Math.min(needed, held));
}

/** The query that asks for turns older than `oldest`, or null when there is nothing to anchor on. */
export function olderQuery(oldest: string | undefined): string | null {
  if (oldest === undefined || oldest === "") return null;
  return `limit=${String(HISTORY_PAGE_SIZE)}&before=${encodeURIComponent(oldest)}`;
}
