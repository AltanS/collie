// The change marks on the Changes screen's folder tree (ADR 0083, 2026-10-06): which rows of one
// folder changed, which folders hold changes and how many, and which deleted files the disk no
// longer lists. The change set is the Changes list's own answer, joined to a folder listing by the
// path from the root. Pure, so the route, the playground and the unit suite read one arithmetic.

import { rootPathOf } from "./files-view";
import type { ChangedRepo, ChangeStatus, FileEntry } from "./types";

/** One changed path under the root, as the tree marks it and the diff route asks for it. */
export interface RootChange {
  /**
   * The path from the root, `/`-separated. An untracked folder carries no trailing slash here. `""`
   * is the root itself, when git lists an untracked folder that holds it: everything is new.
   */
  rootPath: string;
  /** The repo's id in the Changes answer (`relPath`). */
  repo: string;
  /** The path inside that repo, exactly as the Changes answer spelled it. */
  path: string;
  status: ChangeStatus;
  oldPath?: string;
  /** An untracked folder: git listed the folder, not the files in it. */
  folder: boolean;
}

/** What a folder row says: how many changed paths sit below it, and in which colour. */
export interface FolderMark {
  count: number;
  /** The one status every change below shares, else `M`. */
  status: ChangeStatus;
}

/** The change set of one Changes answer, keyed for the tree. */
export interface ChangeIndex {
  /** Every changed path by its path from the root. */
  files: ReadonlyMap<string, RootChange>;
  /** Every folder that holds a changed path, by its path from the root. */
  folders: ReadonlyMap<string, FolderMark>;
  /** The folders that are a repo of their own: an untracked folder's mark never reaches inside one. */
  repoRoots: ReadonlySet<string>;
}

export const EMPTY_CHANGE_INDEX: ChangeIndex = { files: new Map(), folders: new Map(), repoRoots: new Set() };

/** The folder a root path sits in, `""` for the root itself. */
function parentOf(rootPath: string): string {
  const cut = rootPath.lastIndexOf("/");
  return cut === -1 ? "" : rootPath.slice(0, cut);
}

/** Index one Changes answer for the tree. `clean` repos only count as repo boundaries. */
export function indexChanges(
  root: string,
  repos: readonly ChangedRepo[],
  clean: readonly { relPath: string }[] = [],
): ChangeIndex {
  const files = new Map<string, RootChange>();
  const folders = new Map<string, { count: number; statuses: Set<ChangeStatus> }>();
  const repoRoots = new Set<string>();
  for (const repo of [...repos, ...clean]) {
    if (repo.relPath !== "." && !repo.relPath.startsWith("..")) repoRoots.add(repo.relPath);
  }
  for (const repo of repos) {
    for (const file of repo.files) {
      const rootPath = rootPathOf(root, repo.relPath, file.path);
      if (rootPath === null || files.has(rootPath)) continue;
      // `""` is the root itself, untracked as a whole: no row of its own, but every row below is new.
      if (rootPath === "") {
        if (file.status === "?") files.set("", { rootPath, repo: repo.relPath, path: file.path, status: "?", folder: true });
        continue;
      }
      const change: RootChange = { rootPath, repo: repo.relPath, path: file.path, status: file.status, folder: file.path.endsWith("/") };
      if (file.oldPath !== undefined) change.oldPath = file.oldPath;
      files.set(rootPath, change);
      for (let dir = parentOf(rootPath); ; dir = parentOf(dir)) {
        const mark = folders.get(dir) ?? { count: 0, statuses: new Set<ChangeStatus>() };
        mark.count++;
        mark.statuses.add(file.status);
        folders.set(dir, mark);
        if (dir === "") break;
      }
    }
  }
  const marks = new Map<string, FolderMark>();
  for (const [dir, mark] of folders) {
    const [only] = mark.statuses;
    marks.set(dir, { count: mark.count, status: mark.statuses.size === 1 && only !== undefined ? only : "M" });
  }
  return { files, folders: marks, repoRoots };
}

/** How many changed paths sit under the root: the count the Changes-only toggle carries. */
export function changeCount(index: ChangeIndex): number {
  return index.folders.get("")?.count ?? 0;
}

/**
 * The untracked folder `dir` sits in, if any: git listed that folder whole, so everything inside it
 * is new to the repo. It stops at a folder that is a repo of its own, which git in the outer repo
 * also lists as one untracked folder.
 */
function untrackedAbove(dir: string, index: ChangeIndex): RootChange | undefined {
  for (let at = dir; at !== ""; at = parentOf(at)) {
    if (index.repoRoots.has(at)) return undefined;
    const change = index.files.get(at);
    if (change?.folder === true) return change;
  }
  // The root itself untracked: a repo boundary inside it was already met above.
  const whole = index.files.get("");
  return whole?.folder === true ? whole : undefined;
}

/** One row's mark: a changed file or folder, or a folder with changes below it. */
export type EntryMark =
  | {
      kind: "change";
      status: ChangeStatus;
      /** The change the Diff reads, or undefined for a file only marked because its folder is new. */
      change?: RootChange;
      /** On disk no more: listed from the change set, struck through. */
      deleted?: true;
    }
  | { kind: "folder"; mark: FolderMark };

/** Folders first, then by name case-insensitive, then exact: the bridge's own order. */
function compareEntries(a: FileEntry, b: FileEntry): number {
  const fa = a.kind === "dir" ? 0 : 1;
  const fb = b.kind === "dir" ? 0 : 1;
  if (fa !== fb) return fa - fb;
  const la = a.name.toLowerCase();
  const lb = b.name.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** One folder's rows with their marks: what the disk listed, plus what the disk can no longer list. */
export interface MarkedFolder {
  entries: FileEntry[];
  marks: ReadonlyMap<string, EntryMark>;
}

/**
 * Join one folder's listing to the change set.
 *
 * A listed row whose path changed carries its status. A folder with changes below it carries their
 * count. A deleted file is not on disk, so it is added to the rows from the change set, in the
 * bridge's order, and so is a folder that holds only deleted files. A row inside an untracked folder
 * is new, so it is marked `?` without a change of its own. A row git ignores is never marked: git
 * does not track it, so nothing about it changed.
 */
export function markFolder(entries: readonly FileEntry[], dir: string, index: ChangeIndex): MarkedFolder {
  const marks = new Map<string, EntryMark>();
  const rows = [...entries];
  const listed = new Set(entries.map((e) => e.name));
  const prefix = dir === "" ? "" : `${dir}/`;
  const inNew = untrackedAbove(dir, index);

  for (const entry of entries) {
    if (entry.ignored === true) continue;
    const rel = `${prefix}${entry.name}`;
    const own = index.files.get(rel);
    if (own !== undefined) {
      marks.set(entry.name, { kind: "change", status: own.status, change: own });
      continue;
    }
    const below = index.folders.get(rel);
    if (below !== undefined && entry.kind !== "file") {
      marks.set(entry.name, { kind: "folder", mark: below });
      continue;
    }
    if (inNew !== undefined && !index.repoRoots.has(rel)) marks.set(entry.name, { kind: "change", status: "?" });
  }

  // What the change set names in this folder that the disk did not list.
  const missing: FileEntry[] = [];
  for (const change of index.files.values()) {
    if (change.status !== "D" || parentOf(change.rootPath) !== dir) continue;
    const name = change.rootPath.slice(prefix.length);
    if (listed.has(name)) continue;
    listed.add(name);
    missing.push({ name, kind: "file" });
    marks.set(name, { kind: "change", status: "D", change, deleted: true });
  }
  for (const [folder, mark] of index.folders) {
    if (folder === "" || parentOf(folder) !== dir || mark.status !== "D") continue;
    const name = folder.slice(prefix.length);
    if (listed.has(name)) continue;
    listed.add(name);
    missing.push({ name, kind: "dir" });
    marks.set(name, { kind: "folder", mark });
  }
  // Each one where the bridge's order puts it, the listed rows keeping theirs.
  for (const entry of missing.toSorted(compareEntries)) {
    const at = rows.findIndex((row) => compareEntries(entry, row) < 0);
    rows.splice(at === -1 ? rows.length : at, 0, entry);
  }
  return { entries: rows, marks };
}

/** The change a file screen reads its Diff from, by the file's path from the root. */
export function changeAt(index: ChangeIndex, rootPath: string): RootChange | undefined {
  const own = index.files.get(rootPath);
  return own?.folder === true ? undefined : own;
}
