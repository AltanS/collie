// WHICH FOLDER THE CHANGES VIEW LOOKS AT (ADR 0065, § The root is the workspace).
//
// The operator thinks in workspaces (a herdr workspace, a tmux session, a zellij session), not in
// the folder one pane happens to sit in. A pane parked in `experiments/session-stream` used to show
// that subfolder's repo alone, which was a partial and misleading picture of the work. So the root
// is the WORKSPACE's folder, every pane in a workspace shows the same list, and nested repo
// discovery then runs from that root exactly as it did from a pane's folder.
//
// Pure: the snapshot and the home folder come in as arguments, so the rule is tested without a mux,
// a disk or a server. bridge/server.ts feeds it the live snapshot.

import nodePath from "node:path";

import type { AgentView, WorkspaceView } from "./types.ts";

/**
 * The `node:path` flavour a rule reads paths with. Native by default; a test pins `path.win32` (or
 * `path.posix`) so the Windows branch runs on Linux CI.
 */
export type PathApi = typeof nodePath;

/** A path cut into its root (`/`, `C:\`, `\\srv\share\`) and its folder names. */
interface SplitPath {
  root: string;
  parts: string[];
}

const isWindows = (api: PathApi): boolean => api.sep === "\\";

/** Windows spells a name in any case, and a drive letter or share the same way. POSIX is exact. */
const foldFor = (api: PathApi) => (name: string): string => (isWindows(api) ? name.toLowerCase() : name);

/** `\\?\C:\x` is `C:\x` and `\\?\UNC\srv\share` is `\\srv\share`: same place, a spelling the checks do not know. */
function dropExtendedPrefix(path: string): string {
  if (/^\\\\\?\\UNC\\/i.test(path)) return `\\\\${path.slice(8)}`;
  return path.startsWith("\\\\?\\") ? path.slice(4) : path;
}

function splitPath(path: string, api: PathApi): SplitPath {
  const win = isWindows(api);
  const plain = win ? dropExtendedPrefix(path) : path;
  const root = api.parse(plain).root;
  const parts = plain.slice(root.length).split(win ? /[\\/]+/ : /\/+/).filter(Boolean);
  return { root: win ? root.replaceAll("/", "\\") : root, parts };
}

/** Whether `folder` is an absolute, non-blank path in this flavour: the test for "a folder we can look in". */
export function isAbsoluteFolder(folder: string, pathApi: PathApi = nodePath): boolean {
  return folder.trim() !== "" && pathApi.isAbsolute(folder);
}

/**
 * Whether `folder` is `parent` or sits anywhere below it. By folder names, so `/a/ab` is not inside
 * `/a/a`, and on Windows by case-folded names, so `c:\users\pat` is inside `C:\Users\Pat`. A path on
 * another drive or share is never inside. Pure: neither path has to exist.
 */
export function isInside(opts: { folder: string; parent: string; pathApi?: PathApi }): boolean {
  const api = opts.pathApi ?? nodePath;
  const fold = foldFor(api);
  const child = splitPath(opts.folder, api);
  const parent = splitPath(opts.parent, api);
  if (fold(child.root) !== fold(parent.root)) return false;
  if (parent.parts.length > child.parts.length) return false;
  return parent.parts.every((name, i) => fold(name) === fold(child.parts[i]!));
}

/** A path with its trailing separators gone (a root such as `/` or `C:\` stays), or `null` when it is not absolute. */
function normalize(path: string | undefined, api: PathApi): string | null {
  if (path === undefined) return null;
  const trimmed = path.trim();
  if (!isAbsoluteFolder(trimmed, api)) return null;
  const plain = isWindows(api) ? dropExtendedPrefix(trimmed) : trimmed;
  const root = api.parse(plain).root;
  const body = plain.slice(root.length).replace(isWindows(api) ? /[\\/]+$/ : /\/+$/, "");
  return body === "" ? root : `${root}${body}`;
}

/**
 * The deepest folder every path sits in. `null` for no paths, and for paths on different drives or
 * shares, which have no folder in common. A common folder that is only the root comes back as the root.
 */
export function commonAncestor(paths: readonly string[], pathApi: PathApi = nodePath): string | null {
  if (paths.length === 0) return null;
  const fold = foldFor(pathApi);
  const first = splitPath(paths[0]!, pathApi);
  let parts = first.parts;
  for (const path of paths.slice(1)) {
    const other = splitPath(path, pathApi);
    if (fold(other.root) !== fold(first.root)) return null;
    let i = 0;
    while (i < parts.length && i < other.parts.length && fold(parts[i]!) === fold(other.parts[i]!)) i++;
    parts = parts.slice(0, i);
  }
  return `${first.root === "" ? pathApi.sep : first.root}${parts.join(pathApi.sep)}`;
}

/**
 * Whether a root is narrow enough to scan. A drive or filesystem root (`/`, `C:\`), the home folder
 * itself and every folder above home are not: a list of every repo the operator owns is not one
 * workspace's picture, and a walk of it is the cost the depth caps exist to avoid. A folder outside
 * home (`/srv/app`, `/tmp/x`, another drive) is fine.
 */
export function withinBound(path: string, home: string, pathApi: PathApi = nodePath): boolean {
  if (splitPath(path, pathApi).parts.length === 0) return false;
  const h = normalize(home, pathApi);
  if (h === null || splitPath(h, pathApi).parts.length === 0) return true;
  // Above home or home itself: the candidate holds home. Anything else, home included, is below it.
  return !isInside({ folder: h, parent: path, pathApi });
}

export interface WorkspaceRootInput {
  /** The mux's own folder for the workspace: herdr's worktree checkout, tmux's `session_path`. */
  folder?: string;
  /** The cwd of every pane in the workspace. Blank and relative ones are ignored. */
  cwds: readonly string[];
  /** The operator's home folder, the upper bound. */
  home: string;
  /** The path flavour to read folders with. Native unless a test pins one. */
  pathApi?: PathApi;
}

/**
 * The folder a workspace's Changes list reads, or `null` when there is no narrow enough one.
 *
 * 1. The mux's own workspace folder, when it has one and it is within the bound.
 * 2. Else the deepest common ancestor of the panes' cwds, when that is within the bound.
 * 3. Else `null`: the pane route falls back to the asking pane's own cwd, the workspace route
 *    answers `no-folder`.
 *
 * A mux folder out of bounds (a tmux session started in `~`) does not end the search: the panes'
 * common folder is still the better answer than none.
 */
export function workspaceRoot(input: WorkspaceRootInput): string | null {
  const api = input.pathApi ?? nodePath;
  const folder = normalize(input.folder, api);
  if (folder !== null && withinBound(folder, input.home, api)) return folder;
  const cwds = input.cwds.map((c) => normalize(c, api)).filter((c): c is string => c !== null);
  const common = commonAncestor(cwds, api);
  if (common !== null && withinBound(common, input.home, api)) return common;
  return null;
}

/** The snapshot slices the root lookup needs. `EngineSnapshot` satisfies it. */
export interface RootSnapshot {
  readonly agents: readonly AgentView[];
  readonly shellPanes: readonly AgentView[];
  readonly workspaces: readonly WorkspaceView[];
}

/** One workspace's root off a live snapshot, with the workspace record it came from. */
export function rootOfWorkspace(
  snap: RootSnapshot,
  workspaceId: string,
  home: string,
): { workspace: WorkspaceView; root: string | null } | null {
  const workspace = snap.workspaces.find((w) => w.workspaceId === workspaceId);
  if (workspace === undefined) return null;
  const cwds = [...snap.agents, ...snap.shellPanes].filter((p) => p.workspaceId === workspaceId).map((p) => p.cwd);
  const input: WorkspaceRootInput = { cwds, home };
  if (workspace.folder !== undefined) input.folder = workspace.folder;
  return { workspace, root: workspaceRoot(input) };
}
