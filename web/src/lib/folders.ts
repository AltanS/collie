import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { fetchFolders, starFolder } from "@/lib/api";
import { mutate } from "@/lib/mutate";
import { scopeKey, type Scope } from "@/lib/scope";
import type { FoldersResponse } from "@/lib/types";

// The new-space sheet's folder list (#289, M40/02): the folders a space was created in on ONE
// machine, and the ones the operator starred. The list is that machine's own — its bridge keeps it
// in `folders.json` and records Recent itself after a create that worked — so this module is the
// bridge's mirror and nothing more. It READS: when the sheet opens, again whenever the sheet's chosen
// machine changes, and once ahead of time through {@link prefetchFolders}. It never polls, and the
// list is not in the snapshot.
//
// THE LAST GOOD READ PER SCOPE IS KEPT IN MEMORY, so the sheet opens at its final height. A sheet
// anchored to the bottom grows upward when the sections arrive after it has slid in, and `Collapse`
// draws a section that is open at its first render without animating. Before the cache, the first
// open after every page load, and every separate sheet instance, started empty and then grew
// mid-slide. Now the dashboard and a space prefetch the local list when they mount, every instance
// starts from the cache, and an open still reads again, so a list that really changed redraws. The
// cache is memory only: folder paths are host data and are never written to storage.
//
// A FAILED READ IS NOT AN ERROR STATE, on `useLaunchers`' terms (lib/launchers.ts). A machine on an
// older version answers 404, a machine that is down answers nothing, and both mean the same thing
// here: no list for that machine, and the sheet renders exactly as it did before the list existed.
//
// ONE MACHINE'S LIST IS NEVER SHOWN FOR ANOTHER. What was read is kept with the scope it was read
// for (the cache key is the scope key), and a lookup for another scope never returns it, so switching
// the host picker from the lead to a peer can never leave the lead's folders under the peer's name.

/** One machine's list as the sheet draws it. */
export interface FolderList {
  recent: readonly string[];
  favourites: readonly string[];
  /** That machine's home dir, never drawn as an entry and used to shorten the rest to `~/…`. */
  home: string;
}

export const NO_FOLDERS: FolderList = { recent: [], favourites: [], home: "" };

/** One trailing slash dropped, never the root's — the bridge's own spelling rule (bridge/folders.ts). */
function trimSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** A folder's name in its row: the last segment. `/srv/app/` names `app`; `/` names itself. */
export function folderName(path: string): string {
  const trimmed = trimSlash(path);
  const cut = trimmed.lastIndexOf("/");
  const name = cut < 0 ? trimmed : trimmed.slice(cut + 1);
  return name === "" ? trimmed : name;
}

/**
 * The list the sheet may draw: home taken out of both lists. The bridge never records home, so this
 * is the second check rather than the first — it holds against a file written by hand, and against a
 * home that moved after the folder was recorded. A blank field already means home.
 */
export function visibleFolders(list: FolderList): FolderList {
  const home = trimSlash(list.home);
  const shown = (folder: string): boolean => home === "" || trimSlash(folder) !== home;
  return { recent: list.recent.filter(shown), favourites: list.favourites.filter(shown), home: list.home };
}

/** Whether a machine's list has anything to draw at all. */
export function hasFolders(list: FolderList): boolean {
  return list.recent.length > 0 || list.favourites.length > 0;
}

export interface FoldersState {
  /** The chosen machine's list, home removed. {@link NO_FOLDERS} until it is read, and on any failure. */
  folders: FolderList;
  /**
   * Star (`true`) or unstar (`false`) one folder of the chosen machine. The list redraws from the
   * bridge's answer; a refusal says why on the floating status (lib/mutate.ts) and the list is read
   * again, so what is drawn is what the machine holds.
   */
  star: (folder: string, starred: boolean) => Promise<void>;
}

// ── The cache ────────────────────────────────────────────────────────────────────────────────────
// The last successful read per scope key, plus the reads on the wire. Module-level on purpose: every
// sheet instance (the dashboard's, a space's, the pane's) shares it.

type Stored = FoldersResponse | FolderList;

const cache = new Map<string, Stored>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

function remember(key: string, list: Stored): void {
  cache.set(key, list);
  notify();
}

/** A failed read is no list, on the header's terms: the entry goes rather than being kept stale. */
function forget(key: string): void {
  if (cache.delete(key)) notify();
}

/** Read one scope's list into the cache. Never throws: a failure clears the entry. */
async function read(at: Scope, key: string): Promise<void> {
  try {
    remember(key, await fetchFolders(at));
  } catch {
    // See the header: no list for this machine, and nothing to say about it.
    forget(key);
  }
}

/**
 * Read one scope's list into the cache, once, ahead of the sheet. A read already on the wire for the
 * same scope is shared, not repeated. Called when a route that can open the sheet mounts: one read
 * per mount, never a poll and never a timer.
 */
export function prefetchFolders(scope?: Scope): void {
  const at: Scope = { host: scope?.host, session: scope?.session };
  const key = scopeKey(at);
  if (inflight.has(key)) return;
  const pending = read(at, key).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, pending);
}

/** Empty the cache and forget every read on the wire. For tests only: the module outlives each one. */
export function resetFoldersCacheForTests(): void {
  cache.clear();
  inflight.clear();
  notify();
}

/**
 * The chosen machine's folder list, read while `open`. `scope` is the scope the create would be
 * addressed to: absent (solo, or the lead) reads this collie's own list. A list already in the cache
 * for that scope is there on the first render; opening reads again and redraws only if it changed.
 */
export function useFolders(scope: Scope | undefined, open: boolean): FoldersState {
  const host = scope?.host;
  const session = scope?.session;
  const key = scopeKey({ host, session });
  const stored = useSyncExternalStore(
    subscribe,
    () => cache.get(key),
    () => undefined,
  );

  useEffect(() => {
    if (!open) return;
    void read({ host, session }, key);
  }, [open, host, session, key]);

  const star = useCallback(
    async (folder: string, starred: boolean) => {
      const at: Scope = { host, session };
      const outcome = await mutate(() => starFolder(folder, starred, at));
      if (outcome.ok) remember(key, outcome.value);
      else await read(at, key);
    },
    [host, session, key],
  );

  const folders = useMemo(() => (stored === undefined ? NO_FOLDERS : visibleFolders(stored)), [stored]);
  return { folders, star };
}
