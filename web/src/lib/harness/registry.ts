// The adapter registry — the SINGLE decision site for "which agents get the block grammars". Maps a
// Herdr snapshot `agent` string to its HarnessAdapter; anything absent from the map has no adapter,
// so it keeps the universal raw mirror (the T1 fallback). Both gates route through here — the render
// pipeline (harness/index buildBlocks) and agent-chat's status strip — so the policy can't drift, and
// adding a future verified agent is a one-line change to ADAPTERS. `hasBlockGrammar` replaces the old
// grammar/agents predicate: it's now just "is there an adapter for this agent?".

import type { HarnessAdapter } from "./types";
import { claudeAdapter } from "./claude";

// Built FROM the adapter list (not a hand-written literal) so a key can't silently drift from its
// adapter's own `agent` string — the map key IS `adapter.agent`.
const ADAPTERS: Record<string, HarnessAdapter> = Object.fromEntries(
  [claudeAdapter].map((a) => [a.agent, a]),
);

/** The adapter for `agent`, or undefined when the agent is unknown/absent (→ raw fallback). `Object.hasOwn`
 *  (not a truthy `ADAPTERS[agent]`) so an inherited Object.prototype key ("toString", "constructor",
 *  "__proto__", …) can't resolve to a non-adapter and crash the render path. */
export function adapterFor(agent: string | undefined): HarnessAdapter | undefined {
  return agent !== undefined && Object.hasOwn(ADAPTERS, agent) ? ADAPTERS[agent] : undefined;
}

/** Whether `agent` has block grammars (an adapter). The gate agent-chat's status strip shares with
 *  the render pipeline, so the two can't diverge. */
export function hasBlockGrammar(agent: string | undefined): boolean {
  return adapterFor(agent) !== undefined;
}
