import { normalizeHost, type Scope } from "@/lib/scope";
import type { Launcher, WorkspaceView } from "@/lib/types";

// "New agent on a branch" (ADR 0089): a pane's ⋯ menu opens the new-space sheet in worktree mode
// with the pane's repo chosen, a fresh branch name, and an agent picker. Two small rules live here so
// the sheet and the menu can be tested apart from each other.

/** Where the picker remembers the last agent used: a launcher row's `command`, or "" for a shell. */
export const BRANCH_OFF_LAUNCHER_KEY = "collie:branch-off-launcher";

/** The picker's value for "no launcher, a plain shell". Never a row's command: a row's is non-empty. */
export const SHELL_CHOICE = "";

/**
 * The picker's default: the last agent used, when this machine still has that row, else a shell.
 *
 * A remembered command that is no longer in `launchers.toml` falls back to the shell rather than
 * guessing at a neighbour: the bridge would refuse it anyway, and a different agent than the one the
 * operator picked last time is the wrong thing to start silently.
 */
export function defaultLauncher(rows: readonly Launcher[], storage: Pick<Storage, "getItem"> | undefined = safeStorage()): string {
  let stored: string | null = null;
  try {
    stored = storage?.getItem(BRANCH_OFF_LAUNCHER_KEY) ?? null;
  } catch {
    // A locked-down storage: no memory, so the shell.
  }
  if (stored === null || stored === SHELL_CHOICE) return SHELL_CHOICE;
  return rows.some((r) => r.command === stored) ? stored : SHELL_CHOICE;
}

/** Remember the agent just used, for the next sheet. A storage that refuses keeps no memory. */
export function rememberLauncher(choice: string, storage: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  try {
    storage?.setItem(BRANCH_OFF_LAUNCHER_KEY, choice);
  } catch {
    // Private mode or a full quota: the next sheet opens on the shell, which is a safe default.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Whether a pane's menu may offer "New agent on a branch", as far as the menu can tell.
 *
 * Two conditions, both required:
 *  - the multiplexer can create a worktree (`createWorktree`, asked of the lead; tmux and zellij
 *    declare it absent);
 *  - the scope is the lead: no `?h=`. The route is lead-local and a crew does not forward it, so a
 *    member's pane must not offer a create the lead would run in the wrong place.
 *
 * The third, that the pane's space sits in a Git repo, is the caller's: it alone holds the snapshot,
 * and it passes no `onBranchOff` for a pane outside one.
 */
export function branchOffOffered(capable: boolean, scope: Scope | undefined): boolean {
  return capable && normalizeHost(scope?.host) === undefined;
}

/** One entry of the sheet's repo picker. The same shape as `WorktreeRepo` in new-space-sheet.tsx. */
export interface BranchOffRepo {
  workspaceId: string;
  repoRoot: string;
  label: string;
}

/**
 * The repo picker for a branch-off from the pane in `paneWorkspaceId`, and which entry it opens on.
 *
 * The list is the dashboard sheet's: one entry per repo, taken from the space that shows the repo
 * itself. The pane's own repo is chosen. A pane that sits in a worktree has that worktree's repo;
 * when no space shows the repo itself, the pane's own space stands in for it, since the bridge reads
 * the repo off whichever space it is handed. `null` when the pane's space is in no repo at all.
 */
export function branchOffRepos(
  workspaces: readonly WorkspaceView[],
  paneWorkspaceId: string,
): { repos: BranchOffRepo[]; selected: string } | null {
  const space = workspaces.find((w) => w.workspaceId === paneWorkspaceId);
  const repoRoot = space?.repoRoot;
  if (space === undefined || repoRoot === undefined || repoRoot === "") return null;
  const repos: BranchOffRepo[] = workspaces
    .filter((w) => w.repoRoot !== undefined && w.isWorktree === false)
    .map((w) => ({ workspaceId: w.workspaceId, repoRoot: w.repoRoot ?? "", label: w.label }));
  const own = repos.find((r) => r.repoRoot === repoRoot);
  if (own !== undefined) return { repos, selected: own.workspaceId };
  return {
    repos: [{ workspaceId: space.workspaceId, repoRoot, label: space.label }, ...repos],
    selected: space.workspaceId,
  };
}
