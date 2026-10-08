// The branch a pane's folder is on, as the snapshot carries it (bridge/git-head.ts reads it), and the
// one rule for which branch a screen that spans several panes names.
//
// The field is optional on the wire and may come from a crew member, whose body the lead passes on
// untouched, so it is checked here once and every surface reads it through `paneGitHead`.

import type { AgentView, GitHead } from "@/lib/types";

/** How many characters of a detached head's object name a screen shows: git's own short form. */
export const SHORT_SHA = 7;

const OBJECT_NAME = /^[0-9a-f]{7,64}$/;

/**
 * The pane's head, or `null` when it has none or what it has is not one this build knows: a kind
 * added by a newer member, an empty name, an object name that is not hex.
 */
export function paneGitHead(pane: Pick<AgentView, "gitHead">): GitHead | null {
  const head = pane.gitHead;
  if (head === undefined || head === null) return null;
  if (head.kind === "branch") return head.name.length > 0 ? head : null;
  if (head.kind === "detached") return OBJECT_NAME.test(head.sha) ? head : null;
  return null;
}

/** A detached head's object name, cut to git's short form. */
export function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA);
}

function sameHead(a: GitHead, b: GitHead): boolean {
  if (a.kind === "branch") return b.kind === "branch" && a.name === b.name;
  return b.kind === "detached" && a.sha === b.sha;
}

const trim = (path: string): string => path.replace(/[\\/]+$/, "");

/** Whether `path` is `folder` or sits inside it, on either separator, trailing ones ignored. */
function isSameOrUnder(path: string, folder: string): boolean {
  const p = trim(path);
  const f = trim(folder);
  if (f === "") return true;
  return p === f || p.startsWith(`${f}/`) || p.startsWith(`${f}\\`);
}

/**
 * The branch one screen names for a set of panes, or `null` when they do not agree on one.
 *
 * The Files and Changes screen reads one ROOT, the workspace's folder, so its header names the branch
 * of the panes that sit in that root. Panes outside it say nothing about it, and two panes inside it
 * on two different heads (a nested repo, say) leave the header without one rather than guess. Before
 * the root is known (`null`), every pane given counts.
 */
export function scopeGitHead(panes: readonly AgentView[], root: string | null): GitHead | null {
  let found: GitHead | null = null;
  for (const pane of panes) {
    if (root !== null && !isSameOrUnder(pane.cwd, root)) continue;
    const head = paneGitHead(pane);
    if (head === null) continue;
    if (found === null) found = head;
    else if (!sameHead(found, head)) return null;
  }
  return found;
}
