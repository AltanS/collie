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
