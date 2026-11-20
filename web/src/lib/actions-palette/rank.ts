// THE ONE RANKED LIST OF A TYPED FIELD in the Actions palette (ADR 0165): commands, spaces and panes
// together, best match first. A pane row is matched by the switcher's own filter (lib/pane-filter.ts,
// the fields the switcher row draws), a command or a space by lib/fuzzy.ts on its label. No React, no
// DOM, so the ranking is testable alone.
//
// Two rules on top of the score:
//   * On a tie a command ranks before a space, and a space before a pane: a word that names a command
//     is most often typed to run it.
//   * The list never opens on a destructive row. When the best match closes something, the best row
//     that does not comes to the front, so Enter or Go never lands on a close.

import { matchTerm, queryTerms, type Range } from "@/lib/fuzzy";
import { paneRowKey } from "@/lib/hosts";
import { matchPanes, PANE_FILTER, type PaneField, type PaneMatch } from "@/lib/pane-filter";
import type { ActionId } from "@/lib/shortcuts/actions";
import type { AgentView, ServerSummary } from "@/lib/types";

/** The fields the switcher's pane row draws as text (`SWITCHER_DRAWN` in components/agent-sidebar.tsx). */
const DRAWN: ReadonlySet<PaneField> = new Set<PaneField>(["name", "space", "tab", "account"]);

export interface CommandEntry {
  readonly id: ActionId;
  /** The translated word the row shows, which is what is searched. */
  readonly label: string;
  readonly destructive: boolean;
}

export interface SpaceEntry {
  readonly key: string;
  readonly label: string;
}

export interface CommandHit {
  readonly kind: "command";
  readonly command: CommandEntry;
  readonly marks: readonly Range[];
  readonly score: number;
  readonly destructive: boolean;
}

export interface SpaceHit {
  readonly kind: "space";
  readonly space: SpaceEntry;
  readonly marks: readonly Range[];
  readonly score: number;
  readonly destructive: false;
}

export interface PaneHit {
  readonly kind: "pane";
  readonly pane: AgentView;
  readonly match: PaneMatch;
  readonly score: number;
  readonly destructive: false;
}

export type Hit = CommandHit | SpaceHit | PaneHit;

export interface SearchInput {
  readonly query: string;
  readonly commands: readonly CommandEntry[];
  readonly spaces: readonly SpaceEntry[];
  readonly panes: readonly AgentView[];
  readonly servers?: readonly ServerSummary[] | undefined;
}

/**
 * The first row that is not destructive comes to the front, so a list never opens on a close. With
 * nothing but destructive rows the order stands: there is then no safe row to put first.
 */
export function neverFirst<T extends { readonly destructive: boolean }>(rows: readonly T[]): T[] {
  const first = rows[0];
  if (first === undefined || !first.destructive) return [...rows];
  const safe = rows.findIndex((row) => !row.destructive);
  if (safe < 0) return [...rows];
  return [rows[safe]!, ...rows.filter((_, i) => i !== safe)];
}

/**
 * The fuzzy score carries a tiny length term in its last digits: "New space" and "New agent…" differ by
 * one in its last group, and ranking on that would reorder equal matches by label length. Scores are
 * compared in buckets of this size, so equal matches keep the list's order and the kind rule decides.
 */
const SCORE_BUCKET = 10_000;
const KIND_RANK = { command: 0, space: 1, pane: 2 } satisfies Record<Hit["kind"], number>;
const bucket = (hit: Hit): number => Math.floor(hit.score / SCORE_BUCKET);
const byRank = (a: Hit, b: Hit): number => bucket(b) - bucket(a) || KIND_RANK[a.kind] - KIND_RANK[b.kind];

/** Every term against one label: the summed score and the merged marks, or null when a term misses. */
function labelMatch(label: string, terms: readonly string[]): { score: number; marks: Range[] } | null {
  let score = 0;
  const marks: Range[] = [];
  for (const term of terms) {
    const found = matchTerm(label, term, PANE_FILTER.level);
    if (found === null) return null;
    score += found.score;
    marks.push(...found.ranges);
  }
  return { score, marks: marks.toSorted((a, b) => a[0] - b[0]) };
}

/** The ranked list for a typed field; empty when the field holds no term. */
export function searchPalette(input: SearchInput): Hit[] {
  const terms = queryTerms(input.query);
  if (terms.length === 0) return [];
  const hits: Hit[] = [];
  for (const command of input.commands) {
    const found = labelMatch(command.label, terms);
    if (found !== null) hits.push({ kind: "command", command, marks: found.marks, score: found.score, destructive: command.destructive });
  }
  for (const space of input.spaces) {
    const found = labelMatch(space.label, terms);
    if (found !== null) hits.push({ kind: "space", space, marks: found.marks, score: found.score, destructive: false });
  }
  const paneMatches = matchPanes(input.panes, input.query, {
    level: PANE_FILTER.level,
    hidden: PANE_FILTER.hidden,
    drawn: DRAWN,
    ctx: { servers: input.servers },
  });
  for (const pane of input.panes) {
    const match = paneMatches?.get(paneRowKey(pane));
    if (match !== undefined) hits.push({ kind: "pane", pane, match, score: match.hit.score, destructive: false });
  }
  // `toSorted` is stable, so equal rows keep the order they came in: the table's for commands, the
  // snapshot's for spaces and panes.
  return neverFirst(hits.toSorted(byRank));
}

/** A stable key for a row of the list. */
export function hitKey(hit: Hit): string {
  if (hit.kind === "command") return `c:${hit.command.id}`;
  if (hit.kind === "space") return `s:${hit.space.key}`;
  return `p:${paneRowKey(hit.pane)}`;
}
