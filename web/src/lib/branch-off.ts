import { normalizeHost, type Scope } from "@/lib/scope";
import { paneGitHead } from "@/lib/git-head";
import type { AgentView, WorkspaceView } from "@/lib/types";

// "New agent on a branch" (ADR 0089, M48): a pane's ⋯ menu opens the one New sheet on the pane's
// folder with the branch switch on. The menu's gates and the "Start from" rule live here so the
// sheet and the menu can be tested apart from each other.

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

/** Whether the pane's space sits in a Git repo: the third gate on "New agent on a branch". */
export function paneInRepo(workspaces: readonly WorkspaceView[], paneWorkspaceId: string): boolean {
  const repoRoot = workspaces.find((w) => w.workspaceId === paneWorkspaceId)?.repoRoot;
  return repoRoot !== undefined && repoRoot !== "";
}

// ── "Start from" (ADR 0089, amended) ─────────────────────────────────────────────────────────────
//
// A new worktree can start from the repo's default branch or from the branch the pane is on. The
// sheet offers the choice only when there is one to make; these rules sit here so they can be tested
// without rendering it.

/** The two names the control labels its segments with. Present only when there is a choice. */
export interface StartFromChoices {
  /** The repo's default branch, by name. */
  defaultBranch: string;
  /** The branch the source pane is on. Never equal to `defaultBranch`. */
  paneBranch: string;
}

/**
 * The branch the pane's folder is on, or `null` for a detached head, a folder in no checkout, or an
 * older bridge that sends no head. Only a NAMED branch can be a base: a detached head has no name to
 * start a worktree from, and a short object name would be a guess.
 */
export function paneBranchName(pane: Pick<AgentView, "gitHead"> | undefined): string | null {
  if (pane === undefined) return null;
  const head = paneGitHead(pane);
  return head?.kind === "branch" ? head.name : null;
}

/**
 * The control's two names, or `null` when there is nothing to choose between.
 *
 * Needs a source pane on a named branch AND a default branch the bridge could name, and the two must
 * differ: a pane on `main` of a repo whose default is `main` has one possible answer. Anything
 * missing (a dashboard sheet, a detached pane, a bridge that predates the field, a repo with no
 * default) offers no control, and the create then sends `{ kind: "default" }`.
 */
export function startFromChoices(
  paneBranch: string | null | undefined,
  defaultBranch: string | null | undefined,
): StartFromChoices | null {
  if (paneBranch === null || paneBranch === undefined || paneBranch === "") return null;
  if (defaultBranch === null || defaultBranch === undefined || defaultBranch === "") return null;
  return paneBranch === defaultBranch ? null : { defaultBranch, paneBranch };
}
