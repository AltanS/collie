// ONE NAME RULE, AND ONE PLACE RULE, FOR EVERY SURFACE.
//
// A pane used to be named four different ways: the dashboard led with the terminal title, the pane
// header led with `space › tab`, the pills led with the label, and a push named the cwd's basename.
// One pane therefore read as four different panes depending on which screen you were looking at.
//
// The rule is here, once:
//
//   NAME  — paneLabel, else sessionName, else a named one-pane tab's label, else a non-stale
//           terminalTitle, else the agent word
//           ("claude", "codex") for an agent pane and "shell" for a bare shell.
//   PLACE — `space › tab`, or the space alone when the tab carries no name of its own.
//
// The place is never line 1. A name answers "what is this work", a place answers "where does it
// sit", and the two belong on two different lines of every surface that shows both. The agent's
// identity is not in the text at all — it is the mark beside it (AgentIcon).
//
// ── MIRRORED, DELIBERATELY ───────────────────────────────────────────────────
// `bridge/pane-name.ts` holds the same three functions, because a push has to name a pane the way
// the screens do. The two trees have separate tsconfigs and neither imports the other, so the rule
// is mirrored rather than shared — and `bridge/pane-name.fixtures.json` is the one set of cases BOTH
// sides run (pane-name.test.ts here, bridge/pane-name.test.ts there). A rule changed on one side
// alone turns that file red. `tabTitle` below is NOT one of the mirrored three: a push has no
// "lighter ink" to draw, so it names a tab or says nothing about it, never a position in words —
// that is display, web-only, and the bridge copy stays untouched by it.
import { shortCwd } from "./format";
import { t } from "./i18n";
import type { AgentView, TabView } from "./types";

/** The separator between a space and its tab, on every surface that joins them into one string. */
export const PLACE_SEP = " › ";

/**
 * Line 1 on every surface: what this pane is called.
 *
 * The two hand-set names outrank the title because a name you chose should not be overwritten by one
 * the process rewrites every turn. The title outranks the agent word because "claude" tells you
 * nothing when four rows say it. A STALE title names nothing — the program that wrote it has exited,
 * so it is a fact about the past — and such a pane falls back to what it would be called with no
 * title at all. All of these are rendered only as React text nodes by callers, never markup, so they
 * stay within the pane-output XSS boundary.
 */
export function paneName(pane: AgentView): string {
  if (pane.paneLabel) return pane.paneLabel;
  if (pane.sessionName) return pane.sessionName;
  const tab = soleTabName(pane);
  if (tab !== null) return tab;
  if (pane.terminalTitle && pane.terminalTitleStale !== true) return pane.terminalTitle;
  return pane.kind === "shell" ? "shell" : pane.agent;
}

/**
 * The tab's own name, when the operator named the tab and the pane is alone in it; else null.
 *
 * Renaming a one-pane tab is how an operator names a pane (the belt's long-press, or the desktop),
 * and before this rule that name reached no line 1 anywhere: the title Claude writes itself won, so
 * `Ui fixes` read as `Tabs/spaces naming adjustment`. Hand-set names still come first, the title
 * after. The bridge decides whether the tab was NAMED and whether the pane is ALONE in it
 * (state-engine.ts), because only the adapter knows a chosen label from tmux's automatic one; this
 * reads the answer.
 */
export function soleTabName(pane: { soleTabName?: string | undefined }): string | null {
  const name = pane.soleTabName?.trim();
  return name ? name : null;
}

/** zellij's own default name for a tab nobody has named: `Tab #1`, `Tab #2`, … (probed). */
const ZELLIJ_DEFAULT_TAB = /^Tab #\d+$/u;

/**
 * A tab label that says nothing — the multiplexer's positional default, not a name.
 *
 * Herdr labels an unlabelled tab `"1"`, `"2"` (HERDR_API.md § Rename methods); zellij spells the same
 * default `Tab #1`. Neither is a name the operator chose, and both read as a rendering fault when
 * joined to a space (`collie-workspace › 1`). So a positional label never reaches the screen, whether
 * the space has one tab or nine: with nine, the number discriminates, but it discriminates a position
 * the tab strip already shows by position.
 *
 * KNOWN LIMIT, accepted: a tab the operator literally named "1" is indistinguishable from the default
 * and is treated as unnamed. The multiplexer reports one string and no provenance, so there is
 * nothing to tell the two apart. The cost is one hidden label; the benefit is that no screen ever
 * prints a number as a name.
 */
export function isUnnamedTab(label: string | null | undefined): boolean {
  const trimmed = label?.trim();
  if (!trimmed) return true;
  if (/^\d+$/u.test(trimmed)) return true;
  return ZELLIJ_DEFAULT_TAB.test(trimmed);
}

/** `space › tab`, or the space alone when the tab has no name of its own ({@link isUnnamedTab}). */
export function placeOf(space: string, tabLabel: string | null | undefined): string {
  return isUnnamedTab(tabLabel) ? space : `${space}${PLACE_SEP}${tabLabel!.trim()}`;
}

/**
 * A tab's title, wherever one renders alone: the operator's own name, or — when the multiplexer only
 * numbered the tab ({@link isUnnamedTab} true AND a digit is sitting in the raw label, `"2"` or
 * zellij's `"Tab #2"`) — that position in words, `"tab 2"`, read off the digit and never invented.
 * `positional: true` marks the second case so a caller can draw it a shade lighter, the ink the
 * dashboard row has always used for it — this is the SAME text on every surface now, not a dot on
 * some and a number on others. `null` only when the raw label carries no name and no digit at all
 * (an empty label, the honest "nothing to say" case, unchanged since M24).
 */
export interface TabTitle {
  text: string;
  positional: boolean;
}

export function tabTitle(raw: string | null | undefined): TabTitle | null {
  const trimmed = raw?.trim();
  if (!isUnnamedTab(raw)) return { text: trimmed!, positional: false };
  const digits = trimmed?.match(/\d+/u)?.[0];
  if (digits === undefined) return null;
  return { text: t("home.row.tabPosition", { n: digits }), positional: true };
}

/**
 * True when the pane carries a name somebody or something gave it: an operator label, a `/rename`,
 * or a live terminal title. False when {@link paneName} would fall back to the agent word or
 * "shell", which is a kind, not a name.
 */
export function paneHasOwnName(pane: AgentView): boolean {
  if (pane.paneLabel) return true;
  if (pane.sessionName) return true;
  if (soleTabName(pane) !== null) return true;
  return !!pane.terminalTitle && pane.terminalTitleStale !== true;
}

/**
 * What a belt cell says for one tab.
 *
 * A tab that holds ONE pane is that pane, and the cell names the pane the way the header does
 * ({@link paneName}), so the open cell and the header line above it read the same word. Before this
 * the header said `plumbing` (Claude's `/rename`), the open cell said `work` (the Herdr tab), and
 * nothing on the screen tied the two: the belt read as a row of agents that did not include the one
 * on screen. The tab's own label stays for a tab that holds several panes (the label then names a
 * real group), for a tab with no pane, and for a sole pane with nothing but a kind to its name
 * ({@link paneHasOwnName} false), where the operator's `docs` beats a cell that says `shell`.
 */
export function tabCellTitle(raw: string | null | undefined, panes: readonly AgentView[]): TabTitle | null {
  if (panes.length === 1 && paneHasOwnName(panes[0]!)) {
    return { text: paneName(panes[0]!), positional: false };
  }
  return tabTitle(raw);
}

/**
 * The place, unjoined — because at 390px the two halves must not truncate as one string.
 *
 * Eight panes in the same project all begin `moonward_os › `, so tail-truncating the joined place
 * leaves every row reading `moonward_os › …`: the characters that survive are the ones every row
 * shares. Rendering the parts separately lets the SPACE give up width first and the tab — the only
 * discriminator — survive.
 */
export interface PlaceParts {
  space: string;
  /** The tab's title, or null when it has none at all (see {@link tabTitle}). */
  tab: TabTitle | null;
}

/**
 * Where a pane sits, in parts.
 *
 * `tabs` is optional and is the RAW tab list when the caller has it (the pane header does). Without
 * it the pane's own denormalised `tabLabel` is used, which the bridge has already filtered. Either
 * way the label goes through {@link tabTitle}, so a positional label reads the same way on both
 * paths and the two can never disagree.
 */
export function panePlaceParts(pane: AgentView, tabs?: readonly TabView[]): PlaceParts {
  // Host-qualified, the same "untagged is ambient" rule lib/hosts.ts and lib/spaces.ts make: a tab id
  // (`w1:t1`) is unique only within one machine, so a match by id alone could name this pane's place
  // after another member's tab. A solo snapshot tags nothing and matches exactly as it always did.
  const known = tabs?.find((tv) => tv.tabId === pane.tabId && (tv.host === undefined || tv.host === pane.host));
  const raw = known?.label ?? pane.tabLabel;
  return {
    space: pane.workspaceLabel || pane.workspaceId,
    tab: tabTitle(raw),
  };
}

/** The same place, joined — for the surfaces that render it as one run of text. */
export function panePlace(pane: AgentView, tabs?: readonly TabView[]): string {
  const { space, tab } = panePlaceParts(pane, tabs);
  return tab === null ? space : `${space}${PLACE_SEP}${tab.text}`;
}

/** The pane's cwd, shortened for a phone row, or null when it has none. Line 2 of a card that is
 *  ALREADY scoped to one space and tab, where the place is the heading above it. */
export function paneCwdLine(pane: AgentView): string | null {
  return pane.cwd ? shortCwd(pane.cwd) : null;
}
