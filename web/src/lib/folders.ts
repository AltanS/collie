import { useCallback, useEffect, useRef, useState } from "react";

import { fetchFolders, starFolder } from "@/lib/api";
import { mutate } from "@/lib/mutate";
import { scopeKey, type Scope } from "@/lib/scope";
import type { FoldersResponse } from "@/lib/types";

// The new-space sheet's folder list (#289, M40/02): the folders a space was created in on ONE
// machine, and the ones the operator starred. The list is that machine's own — its bridge keeps it
// in `folders.json` and records Recent itself after a create that worked — so this module holds no
// store of its own. It READS: when the sheet opens, and again whenever the sheet's chosen machine
// changes. It never polls, and the list is not in the snapshot.
//
// A FAILED READ IS NOT AN ERROR STATE, on `useLaunchers`' terms (lib/launchers.ts). A machine on an
// older version answers 404, a machine that is down answers nothing, and both mean the same thing
// here: no list for that machine, and the sheet renders exactly as it did before the list existed.
//
// ONE MACHINE'S LIST IS NEVER SHOWN FOR ANOTHER. What was read is kept with the scope it was read
// for, and a list whose scope is not the one asked for now reads as empty, so switching the host
// picker from the lead to a peer can never leave the lead's folders under the peer's name.

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

/**
 * The chosen machine's folder list, read while `open`. `scope` is the scope the create would be
 * addressed to: absent (solo, or the lead) reads this collie's own list.
 */
export function useFolders(scope: Scope | undefined, open: boolean): FoldersState {
  const host = scope?.host;
  const session = scope?.session;
  const key = scopeKey({ host, session });
  const [read, setRead] = useState<{ key: string; list: FoldersResponse | FolderList } | null>(null);
  // The key asked for NOW, read by an answer that arrives after the picker moved on.
  const current = useRef(key);
  current.current = key;

  const load = useCallback(async (at: Scope, forKey: string) => {
    try {
      const list = await fetchFolders(at);
      if (current.current === forKey) setRead({ key: forKey, list });
    } catch {
      // See the header: no list for this machine, and nothing to say about it.
      if (current.current === forKey) setRead({ key: forKey, list: NO_FOLDERS });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load({ host, session }, key);
  }, [open, host, session, key, load]);

  const star = useCallback(
    async (folder: string, starred: boolean) => {
      const at: Scope = { host, session };
      const outcome = await mutate(() => starFolder(folder, starred, at));
      if (current.current !== key) return;
      if (outcome.ok) setRead({ key, list: outcome.value });
      else await load(at, key);
    },
    [host, session, key, load],
  );

  const folders = read !== null && read.key === key ? visibleFolders(read.list) : NO_FOLDERS;
  return { folders, star };
}
