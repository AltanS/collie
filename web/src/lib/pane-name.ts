// What a pane row is CALLED. Every agent used to render as "claude", because the title fell back to
// the agent name and the only distinguishing text was a small trailing workspace label. The agent's
// identity was never really in the text anyway — it's the avatar (AgentIcon) — which frees the title
// line to carry the two things that actually locate a piece of work: the project, and the tab.
//
// Nothing is lost: the pane's own name (a herdr `pane.rename` label, or Claude's own `/rename`
// session name) moves down one line, where it displaces the cwd.
import { shortCwd } from "./format";
import type { AgentView } from "./types";

export interface PaneTitle {
  /** "moonward_os · fix-auth", or just "moonward_os" when the tab label says nothing. */
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

/** The separator between project and tab. Exported so tests and search-text builders agree. */
export const TITLE_SEP = " · ";

/** {@link PaneParts} for a pane — the render-time form of {@link paneTitle}. */
export function paneParts(pane: AgentView): PaneParts {
  const project = pane.workspaceLabel || pane.workspaceId;
  const own = pane.paneLabel || pane.sessionName;
  return {
    project,
    tab: pane.tabLabel ?? null,
    secondary: own || (pane.cwd ? shortCwd(pane.cwd) : null),
  };
}

/**
 * Title and subtitle for a pane row.
 *
 * `tabLabel` is already filtered bridge-side (`meaningfulTabLabel`) — an unlabelled tab in a
 * single-tab space arrives absent rather than as Herdr's positional "1" — so the rule here is
 * simply "use it if it's there".
 *
 * Both fields are rendered as React text nodes by every caller, never markup: the same XSS boundary
 * the pane mirror keeps.
 */
export function paneTitle(pane: AgentView): PaneTitle {
  const { project, tab, secondary } = paneParts(pane);
  return { primary: tab ? `${project}${TITLE_SEP}${tab}` : project, secondary };
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
  const own = pane.paneLabel || pane.sessionName;
  const primary = own || (pane.kind === "shell" ? "shell" : pane.agent);
  const secondary = pane.cwd ? shortCwd(pane.cwd) : null;
  return { primary, secondary };
}

/**
 * One flat string for the places that need a single searchable/announceable name — the command
 * palette's match text, action-sheet headings, aria labels. Carries the same parts the row shows
 * plus the pane's own name, so typing a project, a tab, or a session name all find the pane.
 */
export function paneSearchText(pane: AgentView): string {
  const { primary, secondary } = paneTitle(pane);
  return [primary, secondary, pane.agent].filter(Boolean).join(" ");
}
