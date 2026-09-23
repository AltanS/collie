// THE PANE READ, STARTED WHEN THE FINGER LANDS (lib/pane-prefetch.ts).
//
// The pane route's loader (`paneLoader`, lib/loaders.ts) awaits one pane read before the router
// commits the screen. A glide (lib/glide.ts, the `pane` pair) runs that navigation inside a view
// transition's update callback, and the browser paints no frame while that callback is pending, so a
// slow read would hold a frozen picture on screen. This module starts the read on the row's
// `pointerdown`, about a tap's length before its `click`, and hands the promise to the loader, which
// then usually finds the answer already in.
//
// THE RULES.
//   1. One entry per pane, keyed by the full (host, session, paneId) triple (`paneScopeKey`) and the
//      scrollback window the read asked for. Another machine's `w1:p1` never answers this one.
//   2. Consumed once. The loader takes the entry on the navigation that opens the pane, and the
//      entry is gone; every later poll reads the bridge itself.
//   3. Fresh for PREFETCH_TTL_MS. An entry older than that is not handed out, so a finger that
//      rested on a row and then scrolled away never answers a tap made seconds later.
//   4. The read does NOT mark the pane seen. `pointerdown` also starts a scroll, and a scroll across
//      a finished pane's row must not clear its unseen mark (bridge/server.ts, `marksPaneSeen`). The
//      loader that consumes an entry sends the seen read itself, after the screen is up.
//   5. A read already fresh for the pane is reused, not repeated, so a finger that drags across one
//      row costs one read.

import { fetchPane } from "@/lib/api";
import { paneScopeKey, type Scope } from "@/lib/scope";
import type { PaneReadResponse } from "@/lib/types";

/** How long a started read stays on offer to the loader. */
export const PREFETCH_TTL_MS = 2000;

interface Entry {
  lines: number;
  at: number;
  read: Promise<PaneReadResponse>;
}

const entries = new Map<string, Entry>();

function fresh(entry: Entry | undefined, lines: number, now: number): entry is Entry {
  return entry !== undefined && entry.lines === lines && now - entry.at < PREFETCH_TTL_MS;
}

/**
 * Start (or reuse) the read of one pane at `lines` of scrollback. Returns the read, which settles
 * when the answer is in; it never rejects, so a caller may wait on it without a catch. The loader
 * sees the failure itself when it takes the entry (`takePanePrefetch`).
 */
export function prefetchPane(paneId: string, scope: Scope | undefined, lines: number): Promise<void> {
  const key = paneScopeKey(scope, paneId);
  const now = Date.now();
  const held = entries.get(key);
  if (fresh(held, lines, now)) return settled(held.read);
  const read = fetchPane(paneId, lines, scope, undefined, { seen: false });
  // Handled here so an entry nobody takes is never an unhandled rejection.
  read.catch(() => {});
  entries.set(key, { lines, at: now, read });
  // Stale entries leave on the next start, so the map never outgrows the rows a finger touched.
  for (const [k, e] of entries) if (now - e.at >= PREFETCH_TTL_MS) entries.delete(k);
  return settled(read);
}

/** The moment a read is in, answer or failure, as a promise that never rejects. */
async function settled(read: Promise<PaneReadResponse>): Promise<void> {
  try {
    await read;
  } catch {
    // The failure is the loader's to report, when it takes the entry.
  }
}

/**
 * The read started for this pane, if one is fresh, taken off the shelf: a second call returns
 * `undefined`. The pane loader's only door into this module.
 */
export function takePanePrefetch(
  paneId: string,
  scope: Scope | undefined,
  lines: number,
): Promise<PaneReadResponse> | undefined {
  const key = paneScopeKey(scope, paneId);
  const entry = entries.get(key);
  entries.delete(key);
  return fresh(entry, lines, Date.now()) ? entry.read : undefined;
}

/** Drop every entry. For tests. */
export function resetPanePrefetch(): void {
  entries.clear();
}
