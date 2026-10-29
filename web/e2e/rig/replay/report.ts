// The cost lines a leg prints at its end (M67, ADR 0125): which harness replayed and which ran live,
// the live model turns, and how many requests left the machine for OpenRouter and for Anthropic. Pure,
// so it is tested without a rig; global-teardown.ts gathers the inputs and writes them to the run's
// model.json.
import type { StubStats } from "./stub";
import { STUB_HARNESSES, VENDOR, tierLine, type TierPlans } from "./tier";

/** What a run's model.json holds: the tiers, the stub's counters, and the model turns per harness. */
export interface ModelReport {
  readonly tiers: TierPlans | null;
  readonly stub: StubStats | null;
  /** The leg's own turn count per harness (`turns-<harness>` in the run folder, leg.ts spendTurn). */
  readonly turns: Readonly<Record<string, number>>;
}

/** Where a live harness's turns are paid. */
const PAID = { openrouter: "OpenRouter", anthropic: "subscription" } as const;

/**
 * The cost lines of a run. A replayed harness counts 0 live turns: `live model turns: claude 0` on a
 * Claude replay. A run with no plan for Claude (a model.json from before spec 07) counts Claude's turns
 * as live, as it was then. A replay run says `OpenRouter requests this run: 0` and `Anthropic requests
 * this run: 0`.
 */
export function costLines(report: ModelReport): string[] {
  const lines: string[] = [];
  const live: string[] = [];
  if (report.tiers?.claude === undefined) live.push(`claude ${String(report.turns.claude ?? 0)} (subscription)`);
  const sent = { openrouter: 0, anthropic: 0 };
  for (const h of STUB_HARNESSES) {
    const plan = report.tiers?.[h];
    if (plan === undefined) continue;
    const vendor = VENDOR[h];
    const counts = report.stub?.harnesses[h];
    if (counts !== undefined) sent[vendor] += counts.proxied;
    let served = "";
    if (counts !== undefined) served = plan.tier === "replay" ? `, ${String(counts.replayed)} model calls replayed` : `, ${String(counts.proxied)} model calls to ${vendor === "anthropic" ? "Anthropic" : "OpenRouter"}${plan.record ? `, ${String(counts.recorded)} recorded` : ""}`;
    const mismatch = counts !== undefined && counts.mismatches > 0 ? `, ${String(counts.mismatches)} CASSETTE MISMATCH(ES)` : "";
    lines.push(`model: ${tierLine(plan)}${served}${mismatch}`);
    if (plan.tier === "live") live.push(`${h} ${String(report.turns[h] ?? 0)}${vendor === "anthropic" ? ` (${PAID[vendor]})` : ""}`);
    else if (h === "claude") live.push("claude 0");
  }
  lines.push(`live model turns: ${live.length === 0 ? "none" : live.join(", ")}`);
  if (report.stub === null) {
    lines.push("OpenRouter requests: unknown (no stub counters)");
    return lines;
  }
  lines.push(`OpenRouter requests this run: ${String(sent.openrouter)}${report.stub.upstream === 0 ? " (no provider key was loaded for a replayed harness)" : ""}`);
  if (report.tiers?.claude !== undefined) lines.push(`Anthropic requests this run: ${String(sent.anthropic)}${report.tiers.claude.tier === "replay" ? " (Claude replayed on a dummy login)" : ""}`);
  return lines;
}
