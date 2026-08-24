// The adapter registry — the SINGLE decision site for "which agents get the block grammars". Maps a
// Herdr snapshot `agent` string to its HarnessAdapter; anything absent from the map has no adapter,
// so it keeps the universal raw mirror (the T1 fallback). Both gates route through here — the render
// pipeline (harness/index buildBlocks) and agent-chat's status strip — so the policy can't drift, and
// adding a further verified agent is a one-line change to ADAPTERS. The list holds three today:
// claude, which lifts every block kind; codex, which is Tier 1 chrome plus Tier-2 probed trust /
// approval / question lifts; grok, which is Tier 1 chrome plus Tier-2 probed permission / ask /
// plan lifts; and omp, which is Tier 1 and lifts none — it contributes chrome
// stripping and the composer gate only. Adapters register by their EXACT agent string only —
// prefix-matching here was the AltanS/collie#99 reject: it would hand a harness's live keystroke
// recipes to any agent string sharing the prefix. `hasBlockGrammar` replaces the old
// grammar/agents predicate:
// it's now just "is there an adapter for this agent?", which is the question both gates actually ask
// (a Tier-1 adapter still owns its pane's pipeline; what it BUILDS is the adapter's own business).

import type { HarnessAdapter } from "./types";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { grokAdapter } from "./grok";
import { ompAdapter } from "./omp";

// Built FROM the adapter list (not a hand-written literal) so a key can't silently drift from its
// adapter's own `agent` string — the map key IS `adapter.agent`.
const ADAPTERS: Record<string, HarnessAdapter> = Object.fromEntries(
  [claudeAdapter, codexAdapter, grokAdapter, ompAdapter].map((a) => [a.agent, a]),
);

/** The adapter for `agent`, or undefined when the agent is unknown/absent (→ raw fallback). `Object.hasOwn`
 *  (not a truthy `ADAPTERS[agent]`) so an inherited Object.prototype key ("toString", "constructor",
 *  "__proto__", …) can't resolve to a non-adapter and crash the render path.
 *
 *  Exact match only. Prefix-folding here was the #99 reject: `startsWith("claude")` would hand
 *  Claude's dialog grammars (and their live keystroke recipes) to any agent string with that
 *  prefix. Variant tolerance for slash catalogs belongs in `canonicalAgent`. */
export function adapterFor(agent: string | undefined): HarnessAdapter | undefined {
  return agent !== undefined && Object.hasOwn(ADAPTERS, agent) ? ADAPTERS[agent] : undefined;
}

/** Whether `agent` has block grammars (an adapter). The gate agent-chat's status strip shares with
 *  the render pipeline, so the two can't diverge. */
export function hasBlockGrammar(agent: string | undefined): boolean {
  return adapterFor(agent) !== undefined;
}
