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
  /** The pane's own name if it has one, else a shortened cwd, else a stale terminal title. Null when
   *  there is none of the three. Always rendered in the row's muted style. */
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

/**
 * The same idea as {@link informativeCwd}, gated against the NAME THAT IS ACTUALLY RENDERED rather
 * than against the project.
 *
 * `informativeCwd` is a herd-list rule and it stays one: there, line 1 IS the project, so comparing
 * the directory's own name to the project is comparing the path to the line above it. The pane
 * header's line 1 is not the project — it is `paneLabel ?? sessionName ?? "space › tab"`, so a
 * hand-set name ("logs", "pack overview") never puts the project on screen and the project-gate
 * would suppress the path that is the only thing left naming the work. Measured over the fixture
 * herd, the project gate hid the path on 14 panes of 14.
 *
 * So the question this asks is the one the reader asks: does the path show me a SEGMENT the name
 * above it does not already show? `…/workspace-sprqvntrs/openplate` under
 * `workspace-sprqvntrs › openplate` says nothing and is dropped; `…/openplate/worktrees/fix-42`
 * carries `worktrees` and `fix-42` and is kept; `~/src/sprqvntrs-api` under `logs` is kept, because
 * `logs` names no directory at all.
 *
 * Segments are compared case-insensitively against the name's own word run, split on everything a
 * path segment cannot contain — so the `›` of a breadcrumb separates two tokens rather than
 * becoming part of one. `~` and the `…` elision marker are not segments and never count.
 */
export function cwdBeyondName(cwd: string, name: string): string | null {
  if (!cwd) return null;
  const short = shortCwd(cwd);
  const shown = new Set(
    name
      .toLowerCase()
      .split(/[^a-z0-9._-]+/)
      .filter(Boolean),
  );
  const segments = short.split("/").filter((s) => s !== "" && s !== "~" && s !== "…");
  if (segments.length === 0) return null;
  if (segments.every((s) => shown.has(s.toLowerCase()))) return null;
  return short;
}

/** The parts of a herd-list row title, unjoined — see {@link PaneParts}. */
export function paneParts(pane: AgentView): PaneParts {
  const project = pane.workspaceLabel || pane.workspaceId;
  // A hand-set name first, then what the pane says it is doing. The title sits ahead of the cwd
  // because it is the only one of the three that tracks the work as it moves — and in the herd this
  // exists to untangle (several agents in ONE project) the cwd is identical on every row, so it
  // discriminates nothing.
  //
  // Unless the title is STALE: the program that wrote it has exited, so it is not what this pane is
  // doing — it is what something here once did. It drops BELOW the cwd rather than out of the row,
  // because it is still the only trace of what ran, and the row's muted line is where a fact you
  // read second belongs.
  const stale = pane.terminalTitle !== undefined && pane.terminalTitleStale === true;
  const own = pane.paneLabel || pane.sessionName || (stale ? "" : pane.terminalTitle);
  const secondary = own || informativeCwd(pane.cwd, project) || (stale ? pane.terminalTitle : null);
  return {
    project,
    tab: pane.tabLabel ?? null,
    secondary: secondary ?? null,
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
