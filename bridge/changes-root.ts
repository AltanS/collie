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

import type { AgentView, WorkspaceView } from "./types.ts";

/** A path with its trailing slashes gone (`/` itself stays `/`), or `null` when it is not absolute. */
function normalize(path: string | undefined): string | null {
  if (path === undefined) return null;
  const trimmed = path.trim();
  if (!trimmed.startsWith("/")) return null;
  const stripped = trimmed.replace(/\/+$/, "");
  return stripped === "" ? "/" : stripped;
}

/** The deepest folder every path sits in. `null` for no paths. */
export function commonAncestor(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  let parts = paths[0]!.split("/").filter(Boolean);
  for (const path of paths.slice(1)) {
    const other = path.split("/").filter(Boolean);
    let i = 0;
    while (i < parts.length && i < other.length && parts[i] === other[i]) i++;
    parts = parts.slice(0, i);
  }
  return `/${parts.join("/")}`;
}

/**
 * Whether a root is narrow enough to scan. `/`, the home folder itself and every folder above home
 * are not: a list of every repo the operator owns is not one workspace's picture, and a walk of it
 * is the cost the depth caps exist to avoid. A folder outside home (`/srv/app`, `/tmp/x`) is fine.
 */
export function withinBound(path: string, home: string): boolean {
  if (path === "/") return false;
  const h = normalize(home);
  if (h === null || h === "/") return true;
  return path !== h && !h.startsWith(`${path}/`);
}

export interface WorkspaceRootInput {
  /** The mux's own folder for the workspace: herdr's worktree checkout, tmux's `session_path`. */
  folder?: string;
  /** The cwd of every pane in the workspace. Blank and relative ones are ignored. */
  cwds: readonly string[];
  /** The operator's home folder, the upper bound. */
  home: string;
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
  const folder = normalize(input.folder);
  if (folder !== null && withinBound(folder, input.home)) return folder;
  const cwds = input.cwds.map(normalize).filter((c): c is string => c !== null);
  const common = commonAncestor(cwds);
  if (common !== null && withinBound(common, input.home)) return common;
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
