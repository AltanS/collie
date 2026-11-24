// WHERE A PANE SITS IN A TREE OF AGENTS THAT START AGENTS, read off a multiplexer's pane metadata.
//
// An orchestrating agent (or a script that starts agents for one) puts three words on each pane it
// opens: the pane's own node id, the node id of the pane that started it, and a role. Collie only
// reads them; it never writes one. The phone uses them to draw the herd as a tree on request
// (web/src/lib/pane-tree.ts), and nothing else in the bridge reads them.
//
// The names are fixed and carry Collie's prefix, so a program that already puts its own `role` or
// `parent` on a pane for its own purposes is never read by accident.
//
// THE IDS ARE OPAQUE AND CHECKED, NEVER CLEANED. An id is a word of ASCII letters, digits, `-` and `_`,
// and a value that is anything else is dropped whole: a cleaned id would be a different id. The
// producer promises uniqueness across the crew (a prefix of the agent's own session id does), which is
// what lets a parent on another machine be found by id alone, with no machine name in it.
//
// THE ROLE IS A SHORT WORD, and anything that is not one is dropped rather than repaired: letters,
// digits, spaces, `-`, `_` and `.`, at most {@link TREE_ROLE_MAX} characters.
import type { PaneTree } from "../types.ts";

/** The pane metadata names Collie reads, in Herdr's token grammar (letters, digits and `_`). */
export const TREE_TOKENS = {
  id: "collie_id",
  parent: "collie_parent",
  role: "collie_role",
} as const;

/** The longest node id, in characters. */
export const TREE_ID_MAX = 64;

/** The longest role, in characters. */
export const TREE_ROLE_MAX = 24;

const ID = new RegExp(`^[A-Za-z0-9_-]{1,${TREE_ID_MAX}}$`, "u");
const ROLE = new RegExp(`^[\\p{L}\\p{N}_.-](?:[\\p{L}\\p{N} _.-]{0,${TREE_ROLE_MAX - 2}}[\\p{L}\\p{N}_.-])?$`, "u");

function idOf(value: string | undefined): string | undefined {
  return value !== undefined && ID.test(value) ? value : undefined;
}

function roleOf(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && ROLE.test(trimmed) ? trimmed : undefined;
}

type MutablePaneTree = { -readonly [K in keyof PaneTree]: PaneTree[K] };

/**
 * The pane's place in a tree from its metadata map, or undefined when it has none. A pane with neither
 * a valid id nor a valid parent is in no tree, whatever role it names. A parent equal to the pane's own
 * id is dropped, so a pane never parents itself.
 */
export function paneTreeOf(tokens: Readonly<Record<string, string>> | null | undefined): PaneTree | undefined {
  if (tokens === null || tokens === undefined) return undefined;
  const id = idOf(tokens[TREE_TOKENS.id]);
  const named = idOf(tokens[TREE_TOKENS.parent]);
  const parent = named === id ? undefined : named;
  if (id === undefined && parent === undefined) return undefined;
  const role = roleOf(tokens[TREE_TOKENS.role]);
  // Assigned, never conditionally spread: absent stays absent.
  const tree: MutablePaneTree = {};
  if (id !== undefined) tree.id = id;
  if (parent !== undefined) tree.parent = parent;
  if (role !== undefined) tree.role = role;
  return tree;
}
