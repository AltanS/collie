// The canary's verdict logic: pure, so `bun test scripts/harness-canary` pins it without an agent.
//
// Four verdicts, and the order of precedence is the invariant: a case that saw a wrong screen is a
// `fail`; a case that never saw the screen it waited for is `not-reached`, never a `pass`; a `fail`
// the known-gaps file names becomes `known-gap`. A flaky model reads as `not-reached`, so it cannot
// turn a run red or green on its own.

import type { KnownGap } from "./known-gaps";

export type CaseVerdict = "pass" | "fail" | "not-reached";
export type Verdict = CaseVerdict | "known-gap";

/** The five scenarios of spec M37/02, by the ids the table, the captures and known-gaps.json use. */
export const SCENARIOS = ["idle", "drafts", "sends", "narrow", "start-exit"] as const;
export type ScenarioId = (typeof SCENARIOS)[number];

export function isScenarioId(value: string): value is ScenarioId {
  return SCENARIOS.some((s) => s === value);
}

/** One observed check inside a scenario: one draft, one send, one sampled window. */
export interface CaseResult {
  readonly id: string;
  readonly verdict: CaseVerdict;
  /** What was seen, in words. Empty on a plain pass. */
  readonly detail: string;
}

export interface ScenarioResult {
  readonly agent: string;
  readonly scenario: ScenarioId;
  readonly verdict: Verdict;
  readonly detail: string;
  readonly cases: readonly CaseResult[];
  /** The known-gaps entry that turned a fail into `known-gap`, or that a pass made stale. */
  readonly gap?: KnownGap;
  /** True when a known-gaps entry matched a scenario that passed: the entry may be deleted. */
  readonly staleGap?: boolean;
}

export function passCase(id: string, detail = ""): CaseResult {
  return { id, verdict: "pass", detail };
}

export function failCase(id: string, detail: string): CaseResult {
  return { id, verdict: "fail", detail };
}

export function notReachedCase(id: string, detail: string): CaseResult {
  return { id, verdict: "not-reached", detail };
}

/**
 * A scenario's verdict from its cases. Any fail wins: a wrong screen is a finding even when a later
 * case timed out. No cases at all is `not-reached`, because nothing was judged.
 */
export function scenarioVerdict(cases: readonly CaseResult[]): CaseVerdict {
  if (cases.length === 0) return "not-reached";
  if (cases.some((c) => c.verdict === "fail")) return "fail";
  if (cases.some((c) => c.verdict === "not-reached")) return "not-reached";
  return "pass";
}

/** The one-line detail the table prints: a count on a pass, the first bad case otherwise. */
export function scenarioDetail(cases: readonly CaseResult[]): string {
  const verdict = scenarioVerdict(cases);
  const passed = cases.filter((c) => c.verdict === "pass").length;
  const count = `${passed}/${cases.length}`;
  if (verdict === "pass") return cases.length === 1 ? (cases[0]!.detail || "ok") : count;
  if (cases.length === 0) return "nothing judged";
  const bad = cases.find((c) => c.verdict === verdict)!;
  return `${count}, ${bad.id}: ${bad.detail}`;
}

export function scenarioResult(agent: string, scenario: ScenarioId, cases: readonly CaseResult[]): ScenarioResult {
  return { agent, scenario, verdict: scenarioVerdict(cases), detail: scenarioDetail(cases), cases };
}

/**
 * Apply the known-gaps file to one result. A fail that an entry names becomes `known-gap` and keeps
 * the entry's reason; a pass that an entry names stays a pass and is flagged stale, the same
 * discipline as the lab corpus's `knownRaw`: a fix deletes the entry. `not-reached` is left alone,
 * since an unseen screen says nothing about the gap.
 */
export function applyKnownGaps(result: ScenarioResult, gaps: readonly KnownGap[]): ScenarioResult {
  const gap = gaps.find((g) => g.agent === result.agent && g.scenario === result.scenario);
  if (gap === undefined) return result;
  if (result.verdict === "fail") return { ...result, verdict: "known-gap", gap };
  if (result.verdict === "pass") return { ...result, gap, staleGap: true };
  return result;
}

/** 1 when any scenario failed outright, else 0. Known gaps and unreached screens do not fail a run. */
export function exitCode(results: readonly ScenarioResult[]): number {
  return results.some((r) => r.verdict === "fail") ? 1 : 0;
}

/** Whether a run may be recorded in the ledger for `agent`: no fail anywhere in the run, and every
 *  scenario of this agent reached a verdict. */
export function recordable(agent: string, results: readonly ScenarioResult[]): boolean {
  if (exitCode(results) !== 0) return false;
  const own = results.filter((r) => r.agent === agent);
  return own.length > 0 && own.every((r) => r.verdict !== "not-reached");
}

/** The printed summary: one row per agent and scenario, fixed columns, no colour. */
export function renderTable(results: readonly ScenarioResult[], versions: ReadonlyMap<string, string>): string {
  const rows = results.map((r) => [
    r.agent,
    versions.get(r.agent) ?? "?",
    r.scenario,
    r.verdict,
    r.verdict === "known-gap" ? `${r.detail} (${r.gap?.ref ?? "known gap"})` : r.staleGap ? `${r.detail} (stale known gap: delete the entry)` : r.detail,
  ]);
  const header = ["agent", "version", "scenario", "verdict", "detail"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const line = (cells: readonly string[]) =>
    cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join("  ");
  return [line(header), ...rows.map(line)].join("\n");
}
