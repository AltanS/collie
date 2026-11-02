// WHAT A SPACE IS A CHECKOUT OF, attached at serialise time (M81 spec 06).
//
// A worktree space is named after its folder, and its folder is the branch slug under the repo
// (`worktree-eager-summit-7987`). On its own that name says nothing: not the repo, not the branch,
// not where it was cut from. This module adds the two facts the bridge already holds, the same way a
// pane's `gitHead` rides (server.ts `withActivity`): from memory, never a wait, and no key at all when
// there is nothing to say.
//
// - `gitHead`: the branch of the space's own folder, from the one `GitHeads` reader the panes use.
//   bridge/index.ts feeds the space folders into its refresh set beside the panes' folders.
// - `base`: the ref a worktree was cut from, from `worktree-bases.json` on THIS machine, and only for
//   a space that is a linked worktree, and only while the folder is still on the branch the entry was
//   made on (an entry from before the branch was kept has none and always shows): a folder made again
//   on another branch must not show the old one's base (spec 07). A member serves its own views to the lead, which forwards them
//   as they come (crew/merge.ts), so a member's base reaches the phone with no protocol change.

import type { GitHead, GitHeadSurface } from "./git-head.ts";
import type { WorkspaceView } from "./types.ts";
import type { WorktreeBase, WorktreeBaseSurface } from "./worktree-bases.ts";

/** The two readers a space view takes its facts from. Both answer from memory. */
export interface SpaceContextSources {
  /** Absent: no space carries a `gitHead` key (every test that builds the server by hand). */
  gitHeads?: GitHeadSurface;
  bases: Pick<WorktreeBaseSurface, "get">;
}

/**
 * One space view with its `gitHead` and `base` attached where they are known.
 *
 * A space with nothing to add comes back as the SAME object, so a space outside a repo, or one whose
 * head is not read yet, serialises exactly as it did before these fields existed.
 */
export function withSpaceContext(view: WorkspaceView, from: SpaceContextSources): WorkspaceView {
  const folder = view.folder;
  if (folder === undefined) return view;
  const gitHead = from.gitHeads?.get(folder);
  const base = view.isWorktree === true ? baseFor(from.bases.get(folder), gitHead) : undefined;
  if (gitHead === undefined && base === undefined) return view;
  const out: WorkspaceView = { ...view };
  if (gitHead !== undefined) out.gitHead = gitHead;
  if (base !== undefined) out.base = base;
  return out;
}

/** The stored base, when the entry has no branch or its branch is the one the folder is on now. */
function baseFor(entry: WorktreeBase | undefined, gitHead: GitHead | undefined): string | undefined {
  if (entry === undefined) return undefined;
  if (entry.branch === undefined) return entry.base;
  return gitHead?.kind === "branch" && gitHead.name === entry.branch ? entry.base : undefined;
}

/** {@link withSpaceContext} over a whole list; the list itself comes back when no view changed. */
export function withSpacesContext(views: WorkspaceView[], from: SpaceContextSources): WorkspaceView[] {
  const out = views.map((view) => withSpaceContext(view, from));
  return out.every((view, i) => view === views[i]) ? views : out;
}

/** Every space folder in a list, for the `GitHeads` refresh set. */
export function spaceFolders(views: readonly WorkspaceView[]): string[] {
  return views.flatMap((view) => (view.folder === undefined ? [] : [view.folder]));
}
