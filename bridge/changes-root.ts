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

import { dropExtendedPrefix, foldName, HOST, type Host, isInside, splitPath } from "./host.ts";
import type { AgentView, WorkspaceView } from "./types.ts";

/** Whether `folder` is an absolute, non-blank path in this host's flavour: the test for "a folder we can look in". */
export function isAbsoluteFolder(folder: string, host: Host = HOST): boolean {
  return folder.trim() !== "" && host.path.isAbsolute(folder);
}

/** A path with its trailing separators gone (a root such as `/` or `C:\` stays), or `null` when it is not absolute. */
function normalize(path: string | undefined, host: Host): string | null {
  if (path === undefined) return null;
  const trimmed = path.trim();
  if (!isAbsoluteFolder(trimmed, host)) return null;
  const win = host.platform === "win32";
  const plain = win ? dropExtendedPrefix(trimmed) : trimmed;
  const root = host.path.parse(plain).root;
  const body = plain.slice(root.length).replace(win ? /[\\/]+$/ : /\/+$/, "");
  const kept = body === "" ? root : `${root}${body}`;
  // `C:/x` and `C:\x` are one folder. Hand back the host's own spelling, so a caller that keeps the
  // answer as a string (or joins onto it) sees one spelling of it.
  return win ? kept.replaceAll("/", "\\") : kept;
}

/**
 * The deepest folder every path sits in. `null` for no paths, and for paths on different drives or
 * shares, which have no folder in common. A common folder that is only the root comes back as the root.
 */
export function commonAncestor(paths: readonly string[], host: Host = HOST): string | null {
  if (paths.length === 0) return null;
  const fold = (name: string): string => foldName(host, name);
  const first = splitPath(host, paths[0]!);
  let parts = first.parts;
  for (const path of paths.slice(1)) {
    const other = splitPath(host, path);
    if (fold(other.root) !== fold(first.root)) return null;
    let i = 0;
    while (i < parts.length && i < other.parts.length && fold(parts[i]!) === fold(other.parts[i]!)) i++;
    parts = parts.slice(0, i);
  }
  return `${first.root === "" ? host.path.sep : first.root}${parts.join(host.path.sep)}`;
}

/**
 * Whether a root is narrow enough to scan. A drive or filesystem root (`/`, `C:\`), the home folder
 * itself and every folder above home are not: a list of every repo the operator owns is not one
 * workspace's picture, and a walk of it is the cost the depth caps exist to avoid. A folder outside
 * home (`/srv/app`, `/tmp/x`, another drive) is fine.
 */
export function withinBound(path: string, home: string, host: Host = HOST): boolean {
  if (splitPath(host, path).parts.length === 0) return false;
  const h = normalize(home, host);
  if (h === null || splitPath(host, h).parts.length === 0) return true;
  // Above home or home itself: the candidate holds home. Anything else, home included, is below it.
  return !isInside(host, h, path);
}

export interface WorkspaceRootInput {
  /** The mux's own folder for the workspace: herdr's worktree checkout, tmux's `session_path`. */
  folder?: string;
  /** The cwd of every pane in the workspace. Blank and relative ones are ignored. */
  cwds: readonly string[];
  /** The operator's home folder, the upper bound. */
  home: string;
  /** The host whose path rules read the folders. The running machine's unless a test pins one. */
  host?: Host;
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
  const host = input.host ?? HOST;
  const folder = normalize(input.folder, host);
  if (folder !== null && withinBound(folder, input.home, host)) return folder;
  const cwds = input.cwds.map((c) => normalize(c, host)).filter((c): c is string => c !== null);
  const common = commonAncestor(cwds, host);
  if (common !== null && withinBound(common, input.home, host)) return common;
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
