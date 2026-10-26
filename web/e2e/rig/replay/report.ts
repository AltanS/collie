// The cost lines a leg prints at its end (M67, ADR 0125): which harness replayed and which ran live,
// the live model turns, and how many requests left the machine for OpenRouter. Pure, so it is tested
// without a rig; global-teardown.ts gathers the inputs and writes them to the run's model.json.
import type { StubStats } from "./stub";
import { STUB_HARNESSES, tierLine, type TierPlans } from "./tier";

/** What a run's model.json holds: the tiers, the stub's counters, and the model turns per harness. */
export interface ModelReport {
  readonly tiers: TierPlans | null;
  readonly stub: StubStats | null;
  /** The leg's own turn count per harness (`turns-<harness>` in the run folder, leg.ts spendTurn). */
  readonly turns: Readonly<Record<string, number>>;
}

/** The cost lines of a run. A replay run says `OpenRouter requests this run: 0`. */
export function costLines(report: ModelReport): string[] {
  const lines: string[] = [];
  const live: string[] = [`claude ${String(report.turns.claude ?? 0)} (subscription)`];
  for (const h of STUB_HARNESSES) {
    const plan = report.tiers?.[h];
    if (plan === undefined) continue;
    const counts = report.stub?.harnesses[h];
    let served = "";
    if (counts !== undefined) served = plan.tier === "replay" ? `, ${String(counts.replayed)} model calls replayed` : `, ${String(counts.proxied)} model calls to OpenRouter${plan.record ? `, ${String(counts.recorded)} recorded` : ""}`;
    const mismatch = counts !== undefined && counts.mismatches > 0 ? `, ${String(counts.mismatches)} CASSETTE MISMATCH(ES)` : "";
    lines.push(`model: ${tierLine(plan)}${served}${mismatch}`);
    if (plan.tier === "live") live.push(`${h} ${String(report.turns[h] ?? 0)}`);
  }
  lines.push(`live model turns: ${live.join(", ")}`);
  if (report.stub === null) lines.push("OpenRouter requests: unknown (no stub counters)");
  else lines.push(`OpenRouter requests this run: ${String(report.stub.upstream)}${report.stub.upstream === 0 ? " (no provider key was loaded for a replayed harness)" : ""}`);
  return lines;
}
