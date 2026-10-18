// The phone leg's verdicts (M56 spec 10, the phone leg): pure, so a test pins every rule without a
// bridge or an agent. The leg itself (phone.ts) drives a bridge over HTTP and hands its observations
// here. A scenario ends `pass`, `fail` or `not-reached`, in the canary's sense (README, "Verdicts"):
// a scenario whose screen never came is `not-reached`, which is never a pass and never fails the run.
// A fail that known-gaps.json names becomes `known-gap`.

import type { SendReceiptRow } from "../../../web/src/lib/surface/send";
import type { KnownGap } from "../known-gaps";
import { scenarioDetail, scenarioVerdict, type CaseResult, type Verdict } from "../verdict";

/** The phone leg's scenarios, in the order they run. `crew-send` is listed and always `not-reached` today. */
export const PHONE_SCENARIOS = ["idle-send", "stream-sends", "turn-end-send", "command-slash", "ask-answer", "send-on-agents-screen", "crew-send"] as const;
export type PhoneScenarioId = (typeof PHONE_SCENARIOS)[number];

/** How known-gaps.json names a phone scenario: `phone:<id>`, so it never collides with a canary scenario. */
export type PhoneGapId = `phone:${PhoneScenarioId}`;

export function isPhoneGapId(value: string): value is PhoneGapId {
  return PHONE_SCENARIOS.some((id) => `phone:${id}` === value);
}

export function phoneGapId(id: PhoneScenarioId): PhoneGapId {
  return `phone:${id}`;
}

/** One scenario's result, as the ledger row, the commit body and summary.json carry it. */
export interface PhoneScenarioResult {
  readonly id: PhoneScenarioId;
  readonly verdict: Verdict;
  readonly detail: string;
  readonly cases: readonly CaseResult[];
  /** The receipts the scenario's own requests ended with, newest first. Never a text and never a screen row. */
  readonly receipts: readonly SendReceiptRow[];
  /** The `.ansi` capture of the scenario's end, redacted, or null when no pane was reached. */
  readonly capture: string | null;
  readonly gap?: KnownGap;
  readonly staleGap?: boolean;
}

export function phoneResult(id: PhoneScenarioId, cases: readonly CaseResult[], receipts: readonly SendReceiptRow[] = [], capture: string | null = null): PhoneScenarioResult {
  return { id, verdict: scenarioVerdict(cases), detail: scenarioDetail(cases), cases, receipts, capture };
}

/** A known gap turns a fail into `known-gap`; a pass on a listed scenario is a stale entry. Same rule as the canary. */
export function applyPhoneGaps(result: PhoneScenarioResult, harness: string, gaps: readonly KnownGap[]): PhoneScenarioResult {
  const gap = gaps.find((entry) => entry.agent === harness && entry.scenario === phoneGapId(result.id));
  if (gap === undefined) return result;
  if (result.verdict === "fail") return { ...result, verdict: "known-gap", gap };
  if (result.verdict === "pass") return { ...result, gap, staleGap: true };
  return result;
}

/** The send outcomes a phone reads as "it went in". */
export const WENT_IN: readonly string[] = ["sent", "effective"];

/** Outcomes that end a request for good. `held` is not an end, and `sent` may still turn `effective`. */
export const FINAL_BAD: readonly string[] = ["refused", "typed_not_submitted", "unknown", "expired", "cancelled", "discarded"];

/** The newest receipt row of one request, or undefined while the bridge has none. */
export function rowOf(receipts: readonly SendReceiptRow[], requestId: string): SendReceiptRow | undefined {
  return receipts.find((row) => row.requestId === requestId);
}

/** One receipt as words for a log line: outcome, reason, and the keys by name. */
export function receiptWords(row: SendReceiptRow | undefined): string {
  if (row === undefined) return "no receipt";
  return `${row.outcome}${row.reason === undefined ? "" : ` (${row.reason})`}${row.keys.length === 0 ? "" : `, keys ${row.keys.join(" ")}`}`;
}

/**
 * Whether a set of requests has settled for the stream rule: every one ended `effective`, or one of
 * them ended in a way that can no longer become `effective`. `sent` is not settled while the window
 * for its prompt edge is open, so the caller decides when to stop waiting.
 */
export function streamSettled(receipts: readonly SendReceiptRow[], ids: readonly string[], wanted: readonly string[]): boolean {
  return ids.every((id) => {
    const row = rowOf(receipts, id);
    return row !== undefined && (wanted.includes(row.outcome) || FINAL_BAD.includes(row.outcome));
  });
}

/**
 * The stream rule (bug 1 of 1.22.0): every receipt must end in `wanted` (`effective` against a
 * scratch bridge whose hooks reach it, `sent` or `effective` against a running bridge), and no receipt
 * may end `refused` or `typed_not_submitted`. A request with no receipt at the end is still held.
 */
export function judgeStream(receipts: readonly SendReceiptRow[], ids: readonly string[], wanted: readonly string[]): CaseResult[] {
  return ids.map((id, index) => {
    const row = rowOf(receipts, id);
    const name = `send-${String(index + 1)}`;
    if (row === undefined) return { id: name, verdict: "fail", detail: "no receipt: the request was still held when the wait ended" };
    if (wanted.includes(row.outcome)) return { id: name, verdict: "pass", detail: receiptWords(row) };
    if (row.outcome === "held") return { id: name, verdict: "fail", detail: "still held when the wait ended" };
    return { id: name, verdict: "fail", detail: `ended ${receiptWords(row)}, not ${wanted.join(" or ")}${row.detail === undefined ? "" : `: ${row.detail}`}` };
  });
}

/** Words a raw multiplexer or process error carries. A sentence for a person carries none of them. */
const RAW_ERROR = /\b(tmux|herdr|zellij|tern|errno|ENOENT|EPIPE|ECONNREFUSED|stderr|stack|exit code|exited \d|undefined|null|NaN)\b|[{}[\]<>]|\bat\s+\S+:\d+/iu;

/**
 * Whether a refusal's `detail` is a sentence a person can read (bug 3 of 1.22.0 had none): not empty,
 * at least four words, a capital first letter, a full stop at the end, and no raw mux or process words.
 */
export function readableSentence(detail: string | null | undefined): boolean {
  const text = (detail ?? "").trim();
  if (text.length === 0) return false;
  if (text.split(/\s+/u).length < 4) return false;
  if (!/^[A-Z]/u.test(text)) return false;
  if (!/[.!?]$/u.test(text)) return false;
  return !RAW_ERROR.test(text);
}

/** The lab verdict's reasons from the phone leg: one per fail. `not-reached` and `known-gap` add none. */
export function phoneReasons(results: readonly PhoneScenarioResult[]): string[] {
  return results.filter((result) => result.verdict === "fail").map((result) => `phone ${result.id}: ${result.detail}`);
}

/** One line per scenario, for the run log and the commit body. */
export function phoneLines(results: readonly PhoneScenarioResult[]): string[] {
  return results.map((result) => {
    const note = result.verdict === "known-gap" ? ` (${result.gap?.ref ?? "known gap"})` : result.staleGap === true ? " (stale known gap: delete the entry)" : "";
    return `phone ${result.id}: ${result.verdict}: ${result.detail}${note}`;
  });
}

/** The short count the pass evidence carries, e.g. `5 pass, 1 not-reached`. */
export function phoneCount(results: readonly PhoneScenarioResult[]): string {
  const counts = new Map<string, number>();
  for (const result of results) counts.set(result.verdict, (counts.get(result.verdict) ?? 0) + 1);
  return [...counts.entries()].map(([verdict, n]) => `${String(n)} ${verdict}`).join(", ");
}
