// The Changes view's two ways to narrow and arrange its list (ADR 0065): a filter (a path substring
// plus a set of status letters) and a folder tree. Pure, so the route, the playground and the unit
// suite read the same arithmetic.

import type { ChangedFile, ChangedRepo, ChangeStatus } from "@/lib/types";

/** The status letters the filter offers, as drawn. `U` is git's `?` (untracked). */
export const FILTER_STATUSES = ["M", "A", "D", "R", "U"] as const;
export type FilterStatus = (typeof FILTER_STATUSES)[number];

export interface ChangesFilter {
  /** Case-insensitive substring of the path. Blank matches everything. */
  query: string;
  /** None selected means all of them. */
  statuses: readonly FilterStatus[];
}

export const EMPTY_FILTER: ChangesFilter = { query: "", statuses: [] };

export function filterLetter(status: ChangeStatus): FilterStatus {
  return status === "?" ? "U" : status;
}

export function isFilterActive(filter: ChangesFilter): boolean {
  return filter.query.trim() !== "" || filter.statuses.length > 0;
}

export function matchesFilter(file: ChangedFile, filter: ChangesFilter): boolean {
  if (filter.statuses.length > 0 && !filter.statuses.includes(filterLetter(file.status))) return false;
  const q = filter.query.trim().toLowerCase();
  return q === "" || file.path.toLowerCase().includes(q);
}

/** Only the matching files, and only the repos that still have one. Order is kept. */
export function filterRepos(repos: readonly ChangedRepo[], filter: ChangesFilter): ChangedRepo[] {
  if (!isFilterActive(filter)) return [...repos];
  return repos.flatMap((r) => {
    const files = r.files.filter((f) => matchesFilter(f, filter));
    return files.length === 0 ? [] : [{ ...r, files }];
  });
}

export function countFiles(repos: readonly ChangedRepo[]): number {
  return repos.reduce((n, r) => n + r.files.length, 0);
}

// ── The tree ──────────────────────────────────────────────────────────────────

export interface TreeFolder {
  kind: "folder";
  /** The folder's full path with a trailing slash (`src/lib/`): its identity for collapse state. */
  key: string;
  /** What the row shows: one folder name, or a compacted chain (`src/lib`). */
  label: string;
  depth: number;
  children: TreeNode[];
  /** Files anywhere below, and their summed line counts. */
  fileCount: number;
  added: number;
  removed: number;
}

export interface TreeFile {
  kind: "file";
  key: string;
  /** The last segment. An untracked folder (`notes/`) keeps its slash. */
  name: string;
  depth: number;
  file: ChangedFile;
}

export type TreeNode = TreeFolder | TreeFile;

interface Draft {
  folders: Map<string, Draft>;
  files: ChangedFile[];
}

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

function nameOf(path: string): string {
  const trail = path.endsWith("/");
  const bare = trail ? path.slice(0, -1) : path;
  return bare.slice(bare.lastIndexOf("/") + 1) + (trail ? "/" : "");
}

function finish(draft: Draft, prefix: string, depth: number): TreeNode[] {
  const folders: TreeFolder[] = [];
  for (const [name, sub] of draft.folders) {
    // Compact a chain of folders that each hold exactly one folder and no file, as VS Code does.
    let label = name;
    let node = sub;
    for (;;) {
      const only = node.files.length === 0 && node.folders.size === 1 ? [...node.folders][0] : undefined;
      if (!only) break;
      label = `${label}/${only[0]}`;
      node = only[1];
    }
    const key = `${prefix}${label}/`;
    const children = finish(node, key, depth + 1);
    let fileCount = 0;
    let added = 0;
    let removed = 0;
    for (const c of children) {
      if (c.kind === "folder") {
        fileCount += c.fileCount;
        added += c.added;
        removed += c.removed;
      } else {
        fileCount += 1;
        added += c.file.added;
        removed += c.file.removed;
      }
    }
    folders.push({ kind: "folder", key, label, depth, children, fileCount, added, removed });
  }
  const files: TreeFile[] = draft.files
    .map((file) => ({ kind: "file" as const, key: file.path, name: nameOf(file.path), depth, file }))
    .toSorted((a, b) => collator.compare(a.name, b.name));
  return [...folders.toSorted((a, b) => collator.compare(a.label, b.label)), ...files];
}

/** One repo's files as a folder tree: folders first, then files, each by name. */
export function buildChangeTree(files: readonly ChangedFile[]): TreeNode[] {
  const root: Draft = { folders: new Map(), files: [] };
  for (const file of files) {
    const bare = file.path.endsWith("/") ? file.path.slice(0, -1) : file.path;
    const dirs = bare.split("/").slice(0, -1);
    let at = root;
    for (const d of dirs) {
      let next = at.folders.get(d);
      if (!next) {
        next = { folders: new Map(), files: [] };
        at.folders.set(d, next);
      }
      at = next;
    }
    at.files.push(file);
  }
  return finish(root, "", 0);
}

/** Every file of the tree, top to bottom, collapsed folders included: what Previous / Next walk. */
export function treeFiles(nodes: readonly TreeNode[]): ChangedFile[] {
  return nodes.flatMap((n) => (n.kind === "file" ? [n.file] : treeFiles(n.children)));
}

/** The rows a tree draws: a collapsed folder's own row stays, its children do not. */
export function visibleTreeRows(nodes: readonly TreeNode[], collapsed: ReadonlySet<string>): TreeNode[] {
  return nodes.flatMap((n) =>
    n.kind === "file" || collapsed.has(n.key) ? [n] : [n, ...visibleTreeRows(n.children, collapsed)],
  );
}

export type ChangesLayout = "list" | "tree";

/** The order Previous / Next walk: the filtered files, in the order the chosen layout draws them. */
export function layoutOrder(
  repos: readonly ChangedRepo[],
  layout: ChangesLayout,
): { repo: string; path: string }[] {
  return repos.flatMap((r) =>
    (layout === "tree" ? treeFiles(buildChangeTree(r.files)) : r.files).map((f) => ({ repo: r.relPath, path: f.path })),
  );
}

/** An absolute POSIX path with `.` and `..` segments resolved, and no trailing slash. */
function normalizeAbs(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

/**
 * Where a pane's folder sits inside one repo of a Changes list, as a path relative to the repo
 * (`""` for the repo's own folder), or null when the folder is not inside it. `root` is the list's
 * root and `relPath` the repo's path from it, which may climb (`..`) for a repo above the root.
 */
export function folderInRepo(cwd: string, root: string, relPath: string): string | null {
  if (!cwd.startsWith("/")) return null;
  const repoDir = normalizeAbs(`${root}/${relPath}`);
  const at = normalizeAbs(cwd);
  if (at === repoDir) return "";
  const prefix = repoDir === "/" ? "/" : `${repoDir}/`;
  return at.startsWith(prefix) ? at.slice(prefix.length) : null;
}

/**
 * `collapsed` with every folder on the way to `inRepo` opened, in the repo whose collapse keys start
 * with `prefix`. The folder keys are the tree's own (`src/lib/`, trailing slash), so a compacted
 * chain row opens as one. Returns `collapsed` itself when nothing on the way was closed.
 */
export function openFolderChain(collapsed: ReadonlySet<string>, prefix: string, inRepo: string): ReadonlySet<string> {
  if (inRepo === "") return collapsed;
  const at = `${inRepo}/`;
  const onTheWay = [...collapsed].filter((key) => {
    if (!key.startsWith(prefix) || key.length === prefix.length) return false;
    return at.startsWith(key.slice(prefix.length));
  });
  if (onTheWay.length === 0) return collapsed;
  const next = new Set(collapsed);
  for (const key of onTheWay) next.delete(key);
  return next;
}
