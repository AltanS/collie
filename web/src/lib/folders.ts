import { useCallback, useEffect, useRef, useState } from "react";

import { fetchFolders, starFolder } from "@/lib/api";
import { leadHost, scopeHostKey } from "@/lib/hosts";
import { mutate } from "@/lib/mutate";
import { groupPanesByWorkspace } from "@/lib/pane-groups";
import { scopeKey, type Scope } from "@/lib/scope";
import type { AgentView, FoldersResponse, ServerSummary, TabView } from "@/lib/types";

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
//
// "OPEN NOW" IS THE THIRD SECTION, AND IT ASKS THE BRIDGE NOTHING. The folders the chosen machine's
// panes sit in right now are already in the snapshot (`AgentView.cwd`), so they are taken from there
// in the dashboard's place order. They are taken AT THE MOMENT THE LIST IS READ and kept with it,
// never re-derived from a later poll: a pane that opens or closes while the sheet is up must not move
// the Label field and the Create button under a moving thumb (DESIGN.md §2). A machine whose read
// failed has no Open now either, because the star behind each row is that machine's own route and
// the home the section leaves out is that machine's own home.

/** At most this many Open now rows: the start of the herd's folders, not a second dashboard. */
export const MAX_OPEN_NOW = 8;

/** The part of the snapshot Open now reads: the two pane lists, and the tabs the place order sorts by. */
export interface OpenPanes {
  agents: readonly AgentView[];
  shellPanes: readonly AgentView[];
  tabs?: readonly TabView[];
}

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

/**
 * The distinct folders one machine's panes, agents and shells, sit in right now, in the dashboard's
 * place order (lib/pane-groups.ts, `order: "fixed"`): machine, workspace number, tab number, place in
 * the tab. `at` is the scope a create would be addressed to, so absent or host-less means the lead;
 * a pane with no host tag is the lead's (a solo body tags none). An empty cwd is no folder: zellij
 * reports none, and its machine then has no Open now at all. One trailing slash is dropped, the
 * lists' own rule, so `/srv/app/` and `/srv/app` are one row.
 */
export function foldersInUse(
  panes: OpenPanes,
  at: { host?: string } | undefined,
  servers: readonly ServerSummary[],
): string[] {
  const machine = scopeHostKey(at ?? {}, servers);
  const lead = leadHost(servers) ?? "";
  const here = (pane: AgentView): boolean => (pane.host ?? lead) === machine;
  const groups = groupPanesByWorkspace(panes.agents.filter(here), panes.shellPanes.filter(here), {
    order: "fixed",
    tabs: panes.tabs,
    servers,
  });
  const out: string[] = [];
  for (const pane of groups.flatMap((g) => g.panes)) {
    const folder = trimSlash(pane.cwd);
    if (folder !== "" && !out.includes(folder)) out.push(folder);
  }
  return out;
}

/**
 * The Open now rows: `inUse` less home and less every folder already under Favourites or Recent,
 * compared by the same trailing-slash rule, at most {@link MAX_OPEN_NOW}. `list` is the machine's
 * list as read, so its `home` is that machine's own.
 */
export function openNowRows(inUse: readonly string[], list: FolderList): string[] {
  const taken = new Set([list.home, ...list.favourites, ...list.recent].map(trimSlash));
  return inUse.filter((folder) => !taken.has(trimSlash(folder))).slice(0, MAX_OPEN_NOW);
}

export interface FoldersState {
  /** The chosen machine's list, home removed. {@link NO_FOLDERS} until it is read, and on any failure. */
  folders: FolderList;
  /**
   * The Open now rows for the chosen machine, as they stood when its list was read (see the header).
   * Empty until it is read, and on any failure.
   */
  openNow: readonly string[];
  /**
   * Star (`true`) or unstar (`false`) one folder of the chosen machine. The list redraws from the
   * bridge's answer; a refusal says why on the floating status (lib/mutate.ts) and the list is read
   * again, so what is drawn is what the machine holds.
   */
  star: (folder: string, starred: boolean) => Promise<void>;
}

const NO_ROWS: readonly string[] = [];

/** What was read for one scope: the list, and the folders its panes sat in at that moment. */
interface FolderRead {
  key: string;
  list: FoldersResponse | FolderList;
  inUse: readonly string[];
}

/**
 * The chosen machine's folder list, read while `open`. `scope` is the scope the create would be
 * addressed to: absent (solo, or the lead) reads this collie's own list. `inUse` answers the folders
 * that machine's panes sit in NOW ({@link foldersInUse}); it is asked once, when the list's answer
 * lands, and never again until the next read.
 */
export function useFolders(
  scope: Scope | undefined,
  open: boolean,
  inUse: () => readonly string[],
): FoldersState {
  const host = scope?.host;
  const session = scope?.session;
  const key = scopeKey({ host, session });
  const [read, setRead] = useState<FolderRead | null>(null);
  // The key asked for NOW, read by an answer that arrives after the picker moved on.
  const current = useRef(key);
  current.current = key;
  // The newest render's panes, asked by an answer that lands after the render that asked for it.
  const inUseNow = useRef(inUse);
  inUseNow.current = inUse;

  const load = useCallback(async (at: Scope, forKey: string) => {
    try {
      const list = await fetchFolders(at);
      if (current.current === forKey) setRead({ key: forKey, list, inUse: inUseNow.current() });
    } catch {
      // See the header: no list for this machine, and nothing to say about it.
      if (current.current === forKey) setRead({ key: forKey, list: NO_FOLDERS, inUse: [] });
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
      // A star redraws the lists and keeps the Open now it was tapped from: the starred row leaves it
      // for Favourites, and no poll in between adds or drops another.
      if (outcome.ok) {
        setRead((prev) => ({ key, list: outcome.value, inUse: prev?.key === key ? prev.inUse : [] }));
      } else {
        await load(at, key);
      }
    },
    [host, session, key, load],
  );

  const mine = read !== null && read.key === key ? read : null;
  const folders = mine === null ? NO_FOLDERS : visibleFolders(mine.list);
  const openNow = mine === null ? NO_ROWS : openNowRows(mine.inUse, folders);
  return { folders, openNow, star };
}
