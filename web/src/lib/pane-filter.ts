// The session filter's model (M97): which strings of a row are searched, and how a query matches a
// row. Pure, no React. The switcher (components/agent-sidebar.tsx) is its first home and the Dashboard
// its second; both read the row through `paneFields` and match it through `matchPane`.
//
// ── WHAT A ROW IS SEARCHED BY ──────────────────────────────────────────────────────────────────────
// Seven fields, each read through the helper the rows themselves draw with, so the filter can never
// match a string the app would spell differently: the name (`paneName`), the space and the tab
// (`panePlaceParts`), the branch (`paneGitHead`, spelled as `BranchLabel` spells it), the folder (the
// last part of the cwd), the agent program's name as the bridge sends it (no list of harness names
// here), and the machine (`machineLabel`, the name `HostChip` draws, and only on a crew, where the
// chip draws one). A field the row has no value for is the empty string, which no term matches.
//
// ── HOW A QUERY MATCHES ────────────────────────────────────────────────────────────────────────────
// The query is cut into terms at spaces (`queryTerms`). Every term must match some searched field
// (AND), at the level `lib/fuzzy.ts` names. A term marks every field it matched, so a row shows why it
// is there; the marks of all terms are merged per field. The score is the sum, over the terms, of the
// best field score of each.
//
// ── A MATCH IN A FIELD THE ROW DOES NOT DRAW ───────────────────────────────────────────────────────
// Each surface says which fields its row draws (`drawn`). When a term matched ONLY in fields the row
// does not draw, the row would show no reason for being listed, so `via` names the best of those
// fields and the surface draws it in its own second line (`branch fix/748`). With `hidden:
// "drawn-only"` the undrawn fields are not searched at all, except the agent's name.

import { matchTerm, queryTerms, type MatchLevel, type Range } from "@/lib/fuzzy";
import { baseName } from "@/lib/format";
import { paneGitHead, shortSha } from "@/lib/git-head";
import { isMultiHost, paneRowKey } from "@/lib/hosts";
import { t } from "@/lib/i18n";
import { groupByHost, machineLabel, type Machine } from "@/lib/machines";
import { paneName, panePlaceParts } from "@/lib/pane-name";
import type { AgentView, ServerSummary, TabView } from "@/lib/types";

/** How a term matches: `anchored` (substring or word-start abbreviation) or `loose` (any letters in order). */
export type PaneFilterLevel = MatchLevel;
/** `place`: the list keeps its order and groups. `best`: one flat list, best match first. */
export type PaneFilterOrder = "place" | "best";
/** `second-line`: an undrawn field is searched and shown on line 2. `drawn-only`: it is not searched. */
export type PaneFilterHidden = "second-line" | "drawn-only";

export interface PaneFilterSettings {
  readonly level: PaneFilterLevel;
  readonly order: PaneFilterOrder;
  readonly hidden: PaneFilterHidden;
}

/**
 * The three one-line switches of the playground round (M97 spec 05): README decisions 4, 5 and 7.
 * Components take each as an optional prop that defaults to this, so variants render side by side.
 */
export const PANE_FILTER = { level: "anchored", order: "place", hidden: "second-line" } as const satisfies PaneFilterSettings;

export type PaneField = "name" | "space" | "tab" | "branch" | "folder" | "agent" | "machine";

/** Every field, in the order a tie between two undrawn fields is broken. */
export const PANE_FIELDS: readonly PaneField[] = ["name", "space", "tab", "branch", "folder", "agent", "machine"];

/** A row's strings, one per field; the empty string where the row has none. */
export interface PaneFields {
  readonly name: string;
  readonly space: string;
  readonly tab: string;
  readonly branch: string;
  readonly folder: string;
  readonly agent: string;
  readonly machine: string;
}

export interface PaneHit {
  /** Per field, merged over all terms, sorted, never overlapping. */
  readonly marks: Partial<Record<PaneField, readonly Range[]>>;
  /** The sum of the best field score per term. Higher is better; compare, never read. */
  readonly score: number;
  /** The best field that the row kind does not draw, when a term matched ONLY in undrawn fields. */
  readonly via: PaneField | null;
}

/** What `paneFields` needs beyond the pane: the raw tab list (as the row has it) and the crew's roster. */
export interface PaneFieldContext {
  readonly tabs?: readonly TabView[] | undefined;
  readonly servers?: readonly ServerSummary[] | undefined;
}

export interface MatchPaneOptions {
  readonly level: PaneFilterLevel;
  /** The fields the surface's row draws as text. */
  readonly drawn: ReadonlySet<PaneField>;
  readonly hidden: PaneFilterHidden;
}

/** One matched row: its hit, and the strings it was matched against (for the `via` line). */
export interface PaneMatch {
  readonly hit: PaneHit;
  readonly fields: PaneFields;
}

/** The filter field is offered only above this many session rows: a list of five is read, not searched. */
export const FILTER_MIN_ROWS = 6;

/** Whether a list of `count` session rows gets the filter field. */
export function filterOffered(count: number): boolean {
  return count >= FILTER_MIN_ROWS;
}

const machinesOf = new WeakMap<readonly ServerSummary[], Machine[]>();

function machinesFor(servers: readonly ServerSummary[]): Machine[] {
  const cached = machinesOf.get(servers);
  if (cached !== undefined) return cached;
  const machines = groupByHost(servers);
  machinesOf.set(servers, machines);
  return machines;
}

function branchText(pane: AgentView): string {
  const head = paneGitHead(pane);
  if (head === null) return "";
  if (head.kind === "branch") return head.name;
  return t("branch.detached", { sha: shortSha(head.sha) });
}

function machineText(pane: AgentView, servers: readonly ServerSummary[] | undefined): string {
  // HostChip's hide rule: a machine is named only on a crew, and only for a tagged row.
  if (pane.host === undefined || servers === undefined || !isMultiHost(servers)) return "";
  return machineLabel(servers, machinesFor(servers), pane.host);
}

/** The one place that reads a row for the filter. */
export function paneFields(pane: AgentView, ctx: PaneFieldContext = {}): PaneFields {
  const { space, tab } = panePlaceParts(pane, ctx.tabs);
  return {
    name: paneName(pane),
    space,
    tab: tab?.text ?? "",
    branch: branchText(pane),
    folder: pane.cwd ? baseName(pane.cwd) : "",
    // A bare shell runs no agent program; its kind is already its name when it has no other.
    agent: pane.kind === "shell" ? "" : pane.agent,
    machine: machineText(pane, ctx.servers),
  };
}

function mergeRanges(ranges: readonly Range[]): Range[] {
  const sorted = ranges.toSorted((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Range[] = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && range[0] <= last[1]) out[out.length - 1] = [last[0], Math.max(last[1], range[1])];
    else out.push(range);
  }
  return out;
}

/** Every term must match some searched field. null = the row does not match. */
export function matchPane(fields: PaneFields, terms: readonly string[], options: MatchPaneOptions): PaneHit | null {
  const { level, drawn, hidden } = options;
  const searched = PANE_FIELDS.filter((f) => hidden === "second-line" || drawn.has(f) || f === "agent");
  const marks = new Map<PaneField, Range[]>();
  let score = 0;
  let via: PaneField | null = null;
  let viaScore = -1;
  for (const term of terms) {
    let best = -1;
    let drawnHit = false;
    let undrawn: PaneField | null = null;
    let undrawnScore = -1;
    for (const field of searched) {
      const found = matchTerm(fields[field], term, level);
      if (found === null) continue;
      marks.set(field, [...(marks.get(field) ?? []), ...found.ranges]);
      best = Math.max(best, found.score);
      if (drawn.has(field)) drawnHit = true;
      else if (found.score > undrawnScore) {
        undrawn = field;
        undrawnScore = found.score;
      }
    }
    if (best < 0) return null;
    score += best;
    if (!drawnHit && undrawn !== null && undrawnScore > viaScore) {
      via = undrawn;
      viaScore = undrawnScore;
    }
  }
  const merged: Partial<Record<PaneField, readonly Range[]>> = {};
  for (const [field, ranges] of marks) merged[field] = mergeRanges(ranges);
  return { marks: merged, score, via };
}

/**
 * Every row that matches `query`, keyed by `paneRowKey`, or null when the query holds no term (the
 * filter is off and the caller renders exactly what it rendered before).
 */
export function matchPanes(
  panes: readonly AgentView[],
  query: string,
  options: MatchPaneOptions & { readonly ctx?: PaneFieldContext },
): ReadonlyMap<string, PaneMatch> | null {
  const terms = queryTerms(query);
  if (terms.length === 0) return null;
  const out = new Map<string, PaneMatch>();
  for (const pane of panes) {
    const fields = paneFields(pane, options.ctx);
    const hit = matchPane(fields, terms, options);
    if (hit !== null) out.set(paneRowKey(pane), { hit, fields });
  }
  return out;
}

/** The matched rows, best match first; a tie keeps the order the rows came in (the place order). */
export function byScore(rows: readonly AgentView[], hits: ReadonlyMap<string, PaneMatch>): AgentView[] {
  const scoreOf = (p: AgentView) => hits.get(paneRowKey(p))?.hit.score ?? -1;
  return rows.filter((p) => hits.has(paneRowKey(p))).toSorted((a, b) => scoreOf(b) - scoreOf(a));
}
