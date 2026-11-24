// THE HERD AS A TREE: which agent started which (the `tree` pane order, lib/pane-order.ts).
//
// An orchestrating agent that starts other agents puts a node id, its own node id as the child's
// parent, and a role word on each pane it opens (bridge/mux/pane-tree.ts reads them off the
// multiplexer). This module turns those links into one list: each tree in the place of its root, every
// child right under its starter and indented one step, and the panes in no tree after all the trees.
//
// IT IS STRUCTURE, NOT A READING, so nothing here is frozen the way Activity and Cache are (ADR 0147
// point 4). A link changes only when a pane is started or closed, and a pane that arrives or leaves is
// already held still under a finger (hooks/use-still-list.ts). A state change never moves a row: no
// status is read here.
//
// IDS ARE MATCHED ACROSS THE WHOLE CREW, never per machine. The producer promises they are unique, so a
// worker on one machine finds a starter on another by id alone, and no machine name is ever parsed.
//
// A link that leads nowhere degrades, it never drops a row. A parent that is not in the list (closed,
// filtered out, on a machine that is not answering) leaves its child a root of its own. A cycle is cut
// where the walk meets a pane it already drew. Two panes claiming one id: the first in place order owns it.
import { paneRowKey } from "./hosts";
import { asJsonObject, asJsonString } from "./json";
import { bucketOf } from "./triage";
import type { AgentView, PaneTree } from "./types";

/** The deepest indent drawn; a deeper pane is drawn at this depth and still sits under its parent. */
export const TREE_DEPTH_MAX = 4;

const ID = /^[A-Za-z0-9_-]{1,64}$/u;
const ROLE_MAX = 24;

/** The pane's tree, with anything malformed from a peer dropped; null when it is in none. */
export function paneTree(pane: Pick<AgentView, "tree">): PaneTree | null {
  const raw = asJsonObject(pane.tree);
  if (raw === undefined) return null;
  const id = asJsonString(raw.id);
  const parent = asJsonString(raw.parent);
  const role = asJsonString(raw.role)?.trim();
  const tree: PaneTree = {};
  if (id !== undefined && ID.test(id)) tree.id = id;
  if (parent !== undefined && ID.test(parent) && parent !== tree.id) tree.parent = parent;
  if (tree.id === undefined && tree.parent === undefined) return null;
  if (role !== undefined && role !== "" && [...role].length <= ROLE_MAX) tree.role = role;
  return tree;
}

/** The role word an orchestrator gave the pane, or null. */
export function paneRole(pane: Pick<AgentView, "tree">): string | null {
  return paneTree(pane)?.role ?? null;
}

/** Whether any pane of the herd sits in a tree, which is when the `tree` order is offered. */
export function herdHasTree(panes: readonly Pick<AgentView, "tree">[]): boolean {
  return panes.some((p) => paneTree(p) !== null);
}

/**
 * The rows the tree order lays out: the rows the filters left, and every pinned pane as well, in place
 * order (`place`, every pane as the groups run). A pin takes a pane out of its workspace group (ADR 0147
 * point 6), but the tree is not a workspace group: a pinned starter or a pinned child taken out of it
 * would leave its own children with no parent row, and they would fall to the left as if no one had
 * started them. So in the tree order a pinned pane is listed twice, in Pinned and in its place in the tree.
 */
export function treeRows(
  shown: readonly AgentView[],
  pinned: readonly AgentView[],
  place: readonly AgentView[],
): AgentView[] {
  const seen = new Set(shown.map(paneRowKey));
  const extra = pinned.filter((p) => !seen.has(paneRowKey(p)));
  if (extra.length === 0) return [...shown];
  const at = new Map(place.map((p, i) => [paneRowKey(p), i]));
  const rank = (p: AgentView) => at.get(paneRowKey(p)) ?? Number.MAX_SAFE_INTEGER;
  return [...shown, ...extra].toSorted((a, b) => rank(a) - rank(b));
}

export interface TreeLayout {
  /** Every pane given, once each, in tree order. */
  rows: AgentView[];
  /** Row key against depth: 0 for a root and for a pane in no tree. */
  depth: ReadonlyMap<string, number>;
}

/**
 * The panes in tree order. `panes` arrives in place order, and every tie keeps it: roots run in place
 * order, and so do the children of one starter.
 */
export function treeLayout(panes: readonly AgentView[]): TreeLayout {
  const trees = new Map<AgentView, PaneTree>();
  const owner = new Map<string, AgentView>();
  for (const pane of panes) {
    const tree = paneTree(pane);
    if (tree === null) continue;
    trees.set(pane, tree);
    if (tree.id !== undefined && !owner.has(tree.id)) owner.set(tree.id, pane);
  }

  const children = new Map<AgentView, AgentView[]>();
  const roots: AgentView[] = [];
  for (const pane of panes) {
    const parentId = trees.get(pane)?.parent;
    const parent = parentId === undefined ? undefined : owner.get(parentId);
    if (parent === undefined || parent === pane) {
      roots.push(pane);
      continue;
    }
    const kids = children.get(parent);
    if (kids === undefined) children.set(parent, [pane]);
    else kids.push(pane);
  }

  const rows: AgentView[] = [];
  const depth = new Map<string, number>();
  const drawn = new Set<AgentView>();
  const walk = (pane: AgentView, level: number): void => {
    if (drawn.has(pane)) return;
    drawn.add(pane);
    rows.push(pane);
    depth.set(paneRowKey(pane), level);
    for (const kid of children.get(pane) ?? []) walk(kid, level + 1);
  };

  const inTree = (pane: AgentView) => trees.has(pane) || children.has(pane);
  for (const root of roots) if (inTree(root)) walk(root, 0);
  // A cycle has no root: draw what the walk never reached, each where the cycle is entered.
  for (const pane of panes) if (inTree(pane)) walk(pane, 0);
  for (const pane of panes) walk(pane, 0);
  return { rows, depth };
}

/** No folded branch: what the tree order folds by while a query searches every row. */
export const NO_FOLDS: ReadonlySet<string> = new Set();

/** A session that waits on the operator's input (the `needs` bucket), which a folded branch counts and shows. */
export function waitsOnYou(pane: AgentView): boolean {
  return bucketOf(pane) === "needs";
}

/** What a row in the tree order shows of its place: its role and, when its branch is folded, what the fold hides. */
export interface TreePlace {
  role: string | null;
  fold?: { hidden: number; waiting: number };
}

/** One row of the tree order as drawn, once folded branches have taken their descendants away. */
export interface FoldedRow {
  pane: AgentView;
  depth: number;
  /** The branch this row starts, by its node id, when it has children to fold; null for a leaf. */
  branch: string | null;
  /** True when this row's branch is folded and its descendants are not drawn. */
  folded: boolean;
  /** How many descendants a folded branch hides, at every depth. 0 when open. */
  hidden: number;
  /** How many of those hidden descendants wait on the operator. 0 when open. */
  waiting: number;
}

/**
 * The tree order's rows with folded branches closed. A row's descendants are the rows after it in tree order
 * that sit deeper than it, up to the next row at its depth or above (`treeLayout` draws depth first). A branch
 * folds only when its starter carries a node id, the key `folds` names it by; a folded branch draws its starter
 * alone and counts what it hides, and `waits` says which of those wait on the operator.
 */
export function foldTree(layout: TreeLayout, folds: ReadonlySet<string>, waits: (pane: AgentView) => boolean): FoldedRow[] {
  const { rows, depth } = layout;
  const depthAt = (i: number) => depth.get(paneRowKey(rows[i]!)) ?? 0;
  const out: FoldedRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const pane = rows[i]!;
    const level = depthAt(i);
    let end = i + 1;
    while (end < rows.length && depthAt(end) > level) end++;
    const id = paneTree(pane)?.id ?? null;
    const branch = end > i + 1 && id !== null ? id : null;
    const folded = branch !== null && folds.has(branch);
    const hiddenRows = folded ? rows.slice(i + 1, end) : [];
    out.push({ pane, depth: level, branch, folded, hidden: hiddenRows.length, waiting: hiddenRows.filter(waits).length });
    i = folded ? end : i + 1;
  }
  return out;
}

/**
 * The branches to open when the operator opens `id`: that branch, and every branch below it whose subtree holds
 * a pane that waits, so the session waiting on them is drawn after one tap. Branches with nothing waiting keep
 * whatever fold they had.
 */
export function unfoldPath(layout: TreeLayout, id: string, waits: (pane: AgentView) => boolean): string[] {
  const { rows, depth } = layout;
  const depthAt = (i: number) => depth.get(paneRowKey(rows[i]!)) ?? 0;
  const start = rows.findIndex((p) => paneTree(p)?.id === id);
  if (start === -1) return [id];
  const out = [id];
  const stop = (from: number) => {
    let end = from + 1;
    while (end < rows.length && depthAt(end) > depthAt(from)) end++;
    return end;
  };
  const last = stop(start);
  for (let i = start + 1; i < last; i++) {
    const branchId = paneTree(rows[i]!)?.id;
    if (branchId === undefined) continue;
    const end = stop(i);
    if (end > i + 1 && rows.slice(i + 1, end).some(waits)) out.push(branchId);
  }
  return out;
}

/** A pane's relatives in the tree, for moving from one open pane to the next (`treeRelatives`). */
export interface TreeRelatives {
  parent: AgentView | null;
  children: AgentView[];
  previous: AgentView | null;
  next: AgentView | null;
}

const NO_RELATIVES: TreeRelatives = { parent: null, children: [], previous: null, next: null };

/**
 * Where `pane` sits among its relatives, read off the same layout the tree order draws (`treeLayout`, over the
 * herd in place order), so a move lands on the row the list shows next. Its siblings are the panes that share
 * its parent; a pane at the top of a tree has the other tree tops as siblings, and the panes in no tree take
 * no part. No folds apply here: a move into a folded branch is the caller's cue to open it.
 */
export function treeRelatives(layout: TreeLayout, pane: AgentView): TreeRelatives {
  const { rows, depth } = layout;
  const key = paneRowKey(pane);
  const at = rows.findIndex((p) => paneRowKey(p) === key);
  if (at === -1) return NO_RELATIVES;
  const depthAt = (i: number) => depth.get(paneRowKey(rows[i]!)) ?? 0;
  const inTree = (i: number) => paneTree(rows[i]!) !== null || (i + 1 < rows.length && depthAt(i + 1) > depthAt(i));
  const level = depthAt(at);
  if (level === 0 && !inTree(at)) return NO_RELATIVES;

  let parent: AgentView | null = null;
  if (level > 0) {
    for (let i = at - 1; i >= 0; i--) {
      if (depthAt(i) === level - 1) {
        parent = rows[i]!;
        break;
      }
    }
  }
  const children: AgentView[] = [];
  for (let i = at + 1; i < rows.length && depthAt(i) > level; i++) if (depthAt(i) === level + 1) children.push(rows[i]!);

  // Siblings: the rows at this depth inside the same parent's span (or every tree top, at depth 0).
  const siblings: AgentView[] = [];
  const from = parent === null ? 0 : rows.indexOf(parent) + 1;
  for (let i = from; i < rows.length; i++) {
    if (parent !== null && depthAt(i) < level) break;
    if (depthAt(i) === level && (level > 0 || inTree(i))) siblings.push(rows[i]!);
  }
  const me = siblings.indexOf(rows[at]!);
  return {
    parent,
    children,
    previous: me > 0 ? siblings[me - 1]! : null,
    next: me >= 0 && me + 1 < siblings.length ? siblings[me + 1]! : null,
  };
}

/** The node ids of the folded branches that hide `pane`: every folded ancestor, so a move to it can open them. */
export function foldedAncestors(layout: TreeLayout, pane: AgentView, folds: ReadonlySet<string>): string[] {
  const { rows, depth } = layout;
  const at = rows.findIndex((p) => paneRowKey(p) === paneRowKey(pane));
  if (at === -1) return [];
  const out: string[] = [];
  let level = depth.get(paneRowKey(pane)) ?? 0;
  for (let i = at - 1; i >= 0 && level > 0; i--) {
    const d = depth.get(paneRowKey(rows[i]!)) ?? 0;
    if (d !== level - 1) continue;
    const id = paneTree(rows[i]!)?.id;
    if (id !== undefined && folds.has(id)) out.push(id);
    level = d;
  }
  return out;
}
