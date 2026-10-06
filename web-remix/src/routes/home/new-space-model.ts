// The pure half of the new-space sheet: web/src/lib/folders.ts without its React hook, and the repo
// list the worktree tab offers. No stores and no DOM, so `new-space-model.test.ts` checks it as it is.
import type { FoldersResponse, WorkspaceView } from "@web/lib/types";

/** One machine's folder list as the sheet draws it. */
export interface FolderList {
  recent: readonly string[];
  favourites: readonly string[];
  /** That machine's home dir, never drawn as an entry and used to shorten the rest to `~/…`. */
  home: string;
}

export const NO_FOLDERS: FolderList = { recent: [], favourites: [], home: "" };

/** One trailing slash dropped, never the root's: the bridge's own spelling rule (bridge/folders.ts). */
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
 * is the second check rather than the first: it holds against a file written by hand, and against a
 * home that moved after the folder was recorded. A blank field already means home.
 */
export function visibleFolders(list: FolderList | FoldersResponse): FolderList {
  const home = trimSlash(list.home);
  const shown = (folder: string): boolean => home === "" || trimSlash(folder) !== home;
  return { recent: list.recent.filter(shown), favourites: list.favourites.filter(shown), home: list.home };
}

/** Whether a machine's list has anything to draw at all. */
export function hasFolders(list: FolderList): boolean {
  return list.recent.length > 0 || list.favourites.length > 0;
}

/** A repo the sheet can branch a worktree from: one entry per repo, however many spaces show it. */
export interface WorktreeRepo {
  /** The space the worktree call is addressed to (every route is scoped to a space). */
  workspaceId: string;
  repoRoot: string;
  /** What to call it in the picker: the space's own label, which the operator already recognises. */
  label: string;
}

/**
 * Which repos a worktree could be branched from: one entry per repo, taken from the space that shows
 * the repo ITSELF (a worktree's own space would branch from the same repo, so listing both would offer
 * the same thing twice under two names). In the spaces list's order, so the first entry, the sheet's
 * default, is the repo most recently used. `workspaces` is the addressed machine's spaces.
 */
export function worktreeRepos(workspaces: readonly WorkspaceView[]): WorktreeRepo[] {
  const out: WorktreeRepo[] = [];
  for (const w of workspaces) {
    if (w.repoRoot === undefined || w.isWorktree !== false) continue;
    out.push({ workspaceId: w.workspaceId, repoRoot: w.repoRoot, label: w.label });
  }
  return out;
}
