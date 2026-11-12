// THE MENU PLACE AND BOUND PARTS ON THE PHONE (contract 2): which parts a session shows, and how a sheet
// holds a trick's rows. Plain functions; components/trick-menu-group.tsx draws them and
// components/belt-trick-mark.tsx filters the belt with them.
//
// A SESSION is named by its scope key, `<memberId>:<paneId>` (the facts' id), with the pane's walky
// instance token beside it (`AgentView.instance`). A BOUND part (it carries `bound`, bridge/tricks/bound.ts)
// shows only where both match one of its entries, and replaces the trick's unbound part of that place
// there, so a session shows one part of a trick per place. An UNBOUND belt mark shows in every session,
// as before. An UNBOUND menu part shows only in a session of the machine the trick runs on: rows never
// show on a crew member's session unless the instance binds them (the reviewer's rule).

import { collieWordsIn } from "../agent-view/wire";
import { firstHiddenChar } from "../hidden-chars";
import type { AgentView } from "../types";
import { MENU_MESSAGE_MAX, type MenuPart, type MenuRow, type WireTrickPart } from "./schema";

/** What a session is to the menu place: its pane on the phone. */
export type MenuPane = Pick<AgentView, "host" | "paneId" | "kind" | "instance">;

/** The scope key of a pane, as a part of the trick on `partHost` names it (the belt's `from.session`). */
export function sessionKeyOf(pane: Pick<AgentView, "host" | "paneId">, partHost: string): string {
  return `${pane.host ?? partHost}:${pane.paneId}`;
}

/** Whether a pane is an agent session. A pane with no kind comes from a bridge before kinds: it lists agent panes only. */
export function isAgentPane(pane: Pick<AgentView, "kind">): boolean {
  return pane.kind === undefined || pane.kind === "agent";
}

/** Whether a bound part is bound to this pane: its scope key and its instance both match one entry. */
function boundHere(part: WireTrickPart, pane: MenuPane): boolean {
  const key = sessionKeyOf(pane, part.host);
  return part.bound?.some((entry) => entry.session === key && entry.instance === pane.instance) === true;
}

/**
 * The parts of one place a session shows, in the order given: a trick's bound part where it is bound
 * there, else its unbound one. A pane that is undefined or no agent session shows no bound part.
 * `ownOnly`: an unbound part shows only in a session of the trick's own machine (the menu place).
 */
export function partsInSession(parts: readonly WireTrickPart[], pane: MenuPane | undefined, opts: { readonly ownOnly?: boolean } = {}): WireTrickPart[] {
  const agent = pane !== undefined && isAgentPane(pane);
  const boundTricks = new Set(parts.filter((part) => agent && part.bound !== undefined && boundHere(part, pane)).map((part) => `${part.host}/${part.trick}`));
  return parts.filter((part) => {
    if (part.bound !== undefined) return agent && boundHere(part, pane);
    if (boundTricks.has(`${part.host}/${part.trick}`)) return false;
    if (opts.ownOnly !== true) return true;
    return agent && (pane.host === undefined || pane.host === part.host);
  });
}

/** A menu part's rows: the wire read each one again (lib/tricks/wire.ts `readMenuPart`). */
export function menuRowsOf(part: MenuPart): readonly MenuRow[] {
  return part.rows;
}

/** One trick's group of a sheet before the cap: its key, its id for the order, and how many rows it draws. */
export interface MenuGroupSize {
  readonly key: string;
  readonly trick: string;
  /** The rows it draws, its view switch among them. */
  readonly size: number;
  /** It holds the trick's agent view switch, Collie's own row: never left out. */
  readonly keeps?: boolean;
}

/**
 * The groups a sheet shows under the cap of `max` trick rows, in the order of the trick ids, and how many
 * tricks with rows it leaves out. A group is shown whole or left out whole. A group that holds an agent
 * view switch is always shown, and its rows count first.
 */
export interface CappedGroups<T> {
  readonly shown: T[];
  /** How many tricks with rows it leaves out. */
  readonly leftOut: number;
}

export function capGroups<T extends MenuGroupSize>(groups: readonly T[], max: number): CappedGroups<T> {
  const ordered = groups.toSorted((a, b) => (a.trick < b.trick ? -1 : a.trick > b.trick ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  let used = ordered.filter((group) => group.keeps === true).reduce((sum, group) => sum + group.size, 0);
  const kept = new Set<string>();
  let leftOut = 0;
  for (const group of ordered) {
    if (group.keeps === true) {
      kept.add(group.key);
      continue;
    }
    if (used + group.size > max) {
      leftOut += 1;
      continue;
    }
    used += group.size;
    kept.add(group.key);
  }
  return { shown: ordered.filter((group) => kept.has(group.key)), leftOut };
}

/**
 * A tap's message as a group's footer says it after the trick's name: one line, cut to
 * {@link MENU_MESSAGE_MAX} characters with the cut shown. Null when it holds a hidden character or reads
 * as Collie's own words: then the footer says Collie's own line instead.
 */
export function menuMessageLine(message: string): string | null {
  if (firstHiddenChar(message) !== null || collieWordsIn(message) !== null) return null;
  const line = message.replace(/\s+/gu, " ").trim();
  if (line === "") return null;
  const chars = [...line];
  return chars.length <= MENU_MESSAGE_MAX ? line : `${chars.slice(0, MENU_MESSAGE_MAX - 1).join("")}…`;
}
