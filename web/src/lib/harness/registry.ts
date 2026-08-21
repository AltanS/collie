// The adapter registry — the SINGLE decision site for "which agents get the block grammars". Maps a
// Herdr snapshot `agent` string to its HarnessAdapter; anything absent from the map has no adapter,
// so it keeps the universal raw mirror (the T1 fallback). Both gates route through here — the render
// pipeline (harness/index buildBlocks) and agent-chat's status strip — so the policy can't drift, and
// adding a further verified agent is a one-line change to ADAPTERS. The list holds two today: claude,
// which lifts every block kind, and omp, which is Tier 1 and lifts none — it contributes chrome
// stripping and the composer gate only. `hasBlockGrammar` replaces the old grammar/agents predicate:
// it's now just "is there an adapter for this agent?", which is the question both gates actually ask
// (a Tier-1 adapter still owns its pane's pipeline; what it BUILDS is the adapter's own business).

import type { HarnessAdapter } from "./types";
import { claudeAdapter } from "./claude";
import { ompAdapter } from "./omp";
import { agyAdapter, antigravityAdapter } from "./agy";

// Built FROM the adapter list (not a hand-written literal) so a key can't silently drift from its
// adapter's own `agent` string — the map key IS `adapter.agent`.
const ADAPTERS: Record<string, HarnessAdapter> = Object.fromEntries(
  [claudeAdapter, ompAdapter, agyAdapter, antigravityAdapter].map((a) => [a.agent, a]),
);

/** The adapter for `agent`, or undefined when the agent is unknown/absent (→ raw fallback). `Object.hasOwn`
 *  (not a truthy `ADAPTERS[agent]`) so an inherited Object.prototype key ("toString", "constructor",
 *  "__proto__", …) can't resolve to a non-adapter and crash the render path. */
export function adapterFor(agent: string | undefined): HarnessAdapter | undefined {
  if (agent === undefined || agent === null) return undefined;
  const key = agent.toLowerCase().trim();
  if (Object.hasOwn(ADAPTERS, key)) return ADAPTERS[key];
  return undefined;
}

/** Whether `agent` has block grammars (an adapter). The gate agent-chat's status strip shares with
 *  the render pipeline, so the two can't diverge. */
export function hasBlockGrammar(agent: string | undefined): boolean {
  return adapterFor(agent) !== undefined;
}
