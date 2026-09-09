// Reads + caches parsed journals, for whichever adapter the pane's agent selects.
//
// History is fetched ON DEMAND (it is not on the 1.5 s poll path), so the cost that matters is the
// repeat visit, not the first — a parse is reused until the log's size or mtime moves. The cache is
// keyed by absolute path, which is why one store can serve every agent and every herdr session at
// once: two sessions fronting panes whose agents write into the same root still hit the same entry.

import type { AgentSessionRef, JournalAdapter, TranscriptEntry, TranscriptPage } from "./types.ts";

/** How many parsed journals to keep hot. Each is re-parsed only when its file's size/mtime moves. */
const CACHE_MAX = 4;

interface CacheEntry {
  size: number;
  mtimeMs: number;
  complete: boolean;
  entries: TranscriptEntry[];
}

/**
 * Page a parsed journal, newest-anchored: with no cursor you get the LAST `limit` turns (the phone
 * opens at the recent end, like the mirror it replaces); `before` walks backwards from a turn you
 * already hold. Returned entries stay oldest-first so the view renders top-down either way.
 */
/** One page of turns plus the "older exist" flag that drives "load older". */
export type EntryPage = { window: TranscriptEntry[]; hasMore: boolean };

export function pageEntries(
  entries: TranscriptEntry[],
  opts: { limit: number; before?: string },
): EntryPage {
  // An unknown cursor (log rewritten under us, a stale client, or a synthesised cursor whose row
  // fell out of the window) degrades to "newest", never to an empty page — the user asked for older
  // history and must still see something.
  const end =
    opts.before === undefined
      ? entries.length
      : (() => {
          const i = entries.findIndex((e) => e.uuid === opts.before);
          return i === -1 ? entries.length : i;
        })();
  const start = Math.max(0, end - opts.limit);
  return { window: entries.slice(start, end), hasMore: start > 0 };
}

export class TranscriptStore {
  private readonly cache = new Map<string, CacheEntry>();

  /**
   * Read one page of a pane's journal.
   *
   * Null means "nothing to serve" for every reason the client is allowed to distinguish: the ref
   * names no file, the adapter refused the ref's shape, or the path failed containment. Those stay
   * indistinguishable on purpose — a containment failure must not be probeable.
   */
  async page(
    adapter: JournalAdapter,
    ref: AgentSessionRef,
    opts: { limit: number; before?: string },
  ): Promise<Omit<TranscriptPage, "paneId"> | null> {
    const path = await adapter.source.resolve(ref);
    if (path === null) return null;

    // Cache check BEFORE the read: a journal can be 32 MB and paging walks the same file repeatedly,
    // so validity is decided by a stat. Only a moved size/mtime costs a read + parse.
    const meta = await adapter.source.stat(path);
    if (meta === null) return null; // vanished between resolve and read
    const cached = this.cache.get(path);
    let entry: CacheEntry;
    if (cached && cached.size === meta.size && cached.mtimeMs === meta.mtimeMs) {
      entry = cached;
      // Re-set to move it to the end: eviction below is insertion-ordered, so touching a hit keeps
      // the hot journal from being evicted underneath a colder one.
      this.cache.delete(path);
      this.cache.set(path, entry);
    } else {
      const { text, complete, size, mtimeMs } = await adapter.source.load(path);
      entry = { size, mtimeMs, complete, entries: adapter.parse(text) };
      this.cache.set(path, entry);
      if (this.cache.size > CACHE_MAX) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
    }
    const { entries, complete } = entry;

    const { window, hasMore } = pageEntries(entries, opts);
    return {
      entries: window,
      // A clipped file always has more behind it, even at the window's start.
      hasMore: hasMore || (!complete && window.length > 0 && window[0] === entries[0]),
      total: entries.length,
      fileTruncated: !complete,
    };
  }
}
