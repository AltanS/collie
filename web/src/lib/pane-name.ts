// What a pane row is CALLED. Every agent used to render as "claude", because the title fell back to
// the agent name and the only distinguishing text was a small trailing workspace label. The agent's
// identity was never really in the text anyway — it's the avatar (AgentIcon) — which frees the title
// line to carry the two things that actually locate a piece of work: the project, and the tab.
//
// Nothing is lost: the pane's own name (a herdr `pane.rename` label, or Claude's own `/rename`
// session name) moves down one line, where it displaces the cwd.
import { baseName, shortCwd } from "./format";
import { paneDisplayName, type AgentView } from "./types";

/** A two-line row label. Only {@link paneTitleInTab} returns one — the herd list renders
 *  {@link PaneParts} instead, so the project can give up width before the tab does. */
export interface PaneTitle {
  primary: string;
  /** The pane's own name if it has one, else a shortened cwd. Null when there's neither. */
  secondary: string | null;
}

/**
 * The title's parts, unjoined — because at 390px they must not truncate as one string.
 *
 * Eight panes in the same project all begin `moonward_os · `, so tail-truncating the joined title
 * eats the tab name and leaves every row reading `moonward_os · t…`: the 11 characters that survive
 * are the ones every row shares. Rendering the parts separately lets the PROJECT give up width
 * first and the tab — the only discriminator — survive.
 */
export interface PaneParts {
  project: string;
  /** The tab label, or null when it says nothing (see meaningfulTabLabel, bridge-side). */
  tab: string | null;
  /** The pane's own name if it has one, else a shortened cwd. Null when there's neither. */
  secondary: string | null;
}

/** The separator between project and tab, rendered between the two spans. Exported so the tests
 *  assert against one definition rather than a repeated literal. */
export const TITLE_SEP = " · ";

/**
 * The cwd, but only when it says something the title doesn't.
 *
 * A space is almost always named after its directory, so the fallback line spent itself repeating
 * line 1: `moonward_os` above `…/dev/moonward/moonward_os`, on row after row. Dropping it when the
 * directory's own name matches the project keeps the path for exactly the case that carries
 * information — a pane sitting somewhere OTHER than the space root, in a worktree or a subdirectory.
 */
function informativeCwd(cwd: string, project: string): string | null {
  if (!cwd) return null;
  if (baseName(cwd).toLowerCase() === project.trim().toLowerCase()) return null;
  return shortCwd(cwd);
}

/** The parts of a herd-list row title, unjoined — see {@link PaneParts}. */
export function paneParts(pane: AgentView): PaneParts {
  const project = pane.workspaceLabel || pane.workspaceId;
  // A hand-set name first, then what the pane says it is doing. The title sits ahead of the cwd
  // because it is the only one of the three that tracks the work as it moves — and in the herd this
  // exists to untangle (several agents in ONE project) the cwd is identical on every row, so it
  // discriminates nothing.
  const own = pane.paneLabel || pane.sessionName || pane.terminalTitle;
  return {
    project,
    tab: pane.tabLabel ?? null,
    secondary: own || informativeCwd(pane.cwd, project),
  };
}

/**
 * The same row, rendered where the space and tab are ALREADY established by the surrounding UI —
 * the space detail view, which groups panes under a per-tab heading. Repeating `project · tab` on
 * every card there would say nothing, and worse: two panes in one tab would become indistinguishable,
 * since the only thing telling them apart is the pane's own name.
 *
 * So in that scope the pane's own name leads, exactly as it always has, and the cwd sits beneath.
 */
export function paneTitleInTab(pane: AgentView): PaneTitle {
  // paneDisplayName IS this precedence (label -> session name -> agent/"shell"); it was reproduced
  // here line for line, which is two copies of the rule pane-name.ts exists to keep in one place.
  return { primary: paneDisplayName(pane), secondary: pane.cwd ? shortCwd(pane.cwd) : null };
}
