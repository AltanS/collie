// How an operator-declared row says WHICH panes it addresses — shared verbatim by `commands.toml`
// (agent-commands.ts) and `keys.toml` (operator-keys.ts), so the two files can never grow two
// different answers to "does this row apply here?".
//
// The rule and its reasoning are ADR 0018's; this module is only where it is computed.

/** The catalog's own names for the agent families a scope may address. Pinned against CATALOG. */
export const AGENT_FAMILIES = [
  "claude",
  "codex",
  "pi",
  "opencode",
  "omp",
  "agy",
  "antigravity",
] as const;

const FAMILIES: ReadonlySet<string> = new Set<string>(AGENT_FAMILIES);

/** Anything an operator row can be aimed with — the one field the resolution rule reads. */
export interface ScopedRow {
  /** Herdr agent name this row applies to, lowercased. Omitted = every agent. */
  agent?: string;
}

const MISSES = 0;
const UNSCOPED = 1;
const FAMILY = 2;
const EXACT = 3;

/**
 * Fold a PANE's agent name onto the name its catalog is filed under ("claude-code" -> "claude"),
 * or onto itself when nothing ships for it. This is the lookup's variant tolerance, and it is
 * deliberately applied to what Herdr reports, never to what the operator typed as a scope: it is
 * a widening rule, and widening a scope is the one thing {@link rowsFor}'s rule 4 forbids.
 */
export function canonicalAgent(key: string): string {
  if (key === "") return "";
  if (FAMILIES.has(key)) return key;
  if (key.startsWith("claude")) return "claude";
  if (key.startsWith("codex")) return "codex";
  if (key.startsWith("opencode")) return "opencode";
  if (key === "pi" || key.startsWith("pi-") || key.startsWith("pi.")) return "pi";
  // `omp` is its own prefix — no other agent string in the catalog starts with it, and it must NOT
  // be reached by the `pi` rules above: oh-my-pi ships a different command set from pi.dev's.
  if (key.startsWith("omp")) return "omp";
  if (key.startsWith("agy")) return "agy";
  if (key.startsWith("antigravity")) return "antigravity";
  return key;
}

/** How narrowly one row was aimed at this pane — see rule 4 on {@link rowsFor}. */
function specificity(row: ScopedRow, paneKey: string, paneFamily: string): number {
  // An unscoped row applies everywhere, including to an agent with no catalog at all (and to a
  // pane with no agent, where the surface would otherwise never appear).
  if (row.agent === undefined) return UNSCOPED;
  if (paneKey === "") return MISSES;
  const scope = row.agent.toLowerCase().trim();
  if (scope === paneKey) return EXACT;
  // A family scope is only ever the catalog's own name for the family: `claude:` reaches a
  // "claude-code" pane because CLAUDE's shipped rows do; `claude-local:` does NOT, even though the
  // catalog lookup would fold it onto CLAUDE. Folding an arbitrary operator string through that
  // ladder turns a scope written to be narrow into a family-wide one.
  return FAMILIES.has(scope) && scope === paneFamily ? FAMILY : MISSES;
}

/**
 * The operator's rows that address this pane, narrowest first-wins, one row per `keyOf` name.
 *
 * Empty means "nothing of yours points here", which every caller reads as "keep what ships" —
 * rule 2 below.
 *
 * 1. YOUR LIST IS THE LIST. A pane addressed by even one of your rows shows your rows for that
 *    pane and nothing else (ADR 0018).
 * 2. A PANE YOU DID NOT ADDRESS KEEPS WHAT SHIPS. Scoping rows to `omp` says nothing about your
 *    claude panes. Declaring nothing at all leaves every pane as shipped.
 * 3. THE MORE SPECIFIC SCOPE WINS, and one name is one row. Exact (`claude-code` on a claude-code
 *    pane) beats family (`claude` on the same pane) beats unscoped, so "this everywhere, except
 *    here" is spellable and must not render as two identically named buttons. Declaration order
 *    decides only between rows of equal specificity, where the later one wins.
 */
export function rowsFor<T extends ScopedRow>(
  rows: readonly T[],
  agent: string | undefined | null,
  keyOf: (row: T) => string,
): T[] {
  if (rows.length === 0) return [];
  const paneKey = agent?.toLowerCase().trim() ?? "";
  const paneFamily = canonicalAgent(paneKey);
  // One entry per name, keyed by how specifically it was aimed. Insertion order is declaration
  // order and Map.set on an existing key keeps that position, so a scoped row correcting a global
  // one lands where the global one was.
  const aimed = new Map<string, { row: T; aim: number }>();
  for (const row of rows) {
    const aim = specificity(row, paneKey, paneFamily);
    if (aim === MISSES) continue;
    const name = keyOf(row);
    const prev = aimed.get(name);
    if (prev !== undefined && prev.aim > aim) continue;
    aimed.set(name, { row, aim });
  }
  return [...aimed.values()].map((entry) => entry.row);
}
