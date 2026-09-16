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
// The place is never the name. A name answers "what is this work", a place answers "where does it
// sit", and the two belong on two different lines of every surface that shows both.
//
// ── MIRRORED, DELIBERATELY ───────────────────────────────────────────────────
// `web/src/lib/pane-name.ts` holds the same three functions. The two trees have separate tsconfigs
// and neither imports the other, so the rule is mirrored rather than shared — and `pane-name.fixtures.json`
// beside this file is the one set of cases BOTH sides run (bridge/pane-name.test.ts and
// web/src/lib/pane-name.test.ts). A rule changed on one side alone turns that file red.
import type { AgentView } from "./types.ts";

/** The fields the name rule reads. A `Pick` so a caller holding half a pane can still ask. */
export type NameableP = Pick<AgentView, "agent"> &
  Partial<Pick<AgentView, "paneLabel" | "sessionName" | "terminalTitle" | "terminalTitleStale" | "kind" | "soleTabName">>;

/**
 * Line 1 on every surface: what this pane is called.
 *
 * The two hand-set names outrank the title because a name you chose should not be overwritten by one
 * the process rewrites every turn. The title outranks the agent word because "claude" tells you
 * nothing when four rows say it. A STALE title names nothing — the program that wrote it has exited,
 * so it is a fact about the past — and such a pane falls back to what it would be called with no
 * title at all.
 */
export function paneName(pane: NameableP): string {
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
 * the phone cannot act on, and the tab strip already shows position by position.
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

/** The separator between a space and its tab, on every surface that joins them. */
export const PLACE_SEP = " › ";

/** `space › tab`, or the space alone when the tab has no name of its own ({@link isUnnamedTab}). */
export function placeOf(space: string, tabLabel: string | null | undefined): string {
  return isUnnamedTab(tabLabel) ? space : `${space}${PLACE_SEP}${tabLabel!.trim()}`;
}

/**
 * Line 2 on every surface that shows both: where this pane sits.
 *
 * `tabLabel` is already the filtered label (`meaningfulTabLabel` and its per-mux siblings drop a
 * positional one bridge-side), so this only has to join what survived.
 */
export function panePlace(pane: Pick<AgentView, "workspaceLabel"> & Partial<Pick<AgentView, "tabLabel">>): string {
  return placeOf(pane.workspaceLabel, pane.tabLabel);
}
