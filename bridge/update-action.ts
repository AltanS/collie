import type { JsonObject, JsonValue } from "./json.ts";
import { apiError, type ApiErrorBody, type ApiErrorDetail, type ErrorCode } from "./error-codes.ts";
import { compareSemver } from "./update.ts";
import { inFlight, type UpdateRun, type UpdateRunState } from "./update-run.ts";

// `POST /api/update` — the phone's one-tap-plus-one-confirm start, and the preflight it is gated on
// (M15/05).
//
// ── WHY THE BRIDGE RE-DERIVES THE PREFLIGHT SHAPE ────────────────────────────
// The report is produced by `collie update --check --json` (cli/update-check.ts, schema 1). `cli/`
// may import from `bridge/`; nothing in `bridge/` may import from `cli/` — the direction rule stated
// in `bridge/update-run.ts`'s header. So the bridge does what it does with every other foreign
// document: it declares the shape it will believe and parses defensively. This is the same
// arrangement `bridge/json.ts` and `web/src/lib/json.ts` already live with, one boundary further
// out: the producer is a SUBPROCESS, so the two sides could not share a type even if the import
// direction allowed it. {@link PREFLIGHT_SCHEMA} is the version that keeps them honest — a report
// from a schema this build does not know is declined rather than half-read.
//
// ── WHY THE VERDICT IS A PURE FUNCTION ───────────────────────────────────────
// The handler lives inside `Bun.serve`, which `bun test` cannot stand up (CLAUDE.md). Every refusal
// this route can make is therefore decided by {@link updateStartVerdict}, which takes plain values
// and answers a plain value; `bridge/server.ts` renders it. The gate is the one thing NOT decided
// here — it is the pane path's own `guard(req, cfg, "write", pairing)` closure, handed in, so the
// two can never drift into two different answers to the same question (spec 05).

/** The preflight report's schema, as `cli/update-check.ts` stamps it. A report carrying any other
 *  number is declined: a reader that guessed at a document it does not know would gate an update on
 *  fields that had moved. */
export const PREFLIGHT_SCHEMA = 1;

/** One check's answer, as the preflight prints it. `id` is stable; the prose is not. */
export interface PreflightCheck {
  readonly id: string;
  readonly verdict: "green" | "amber" | "red";
  readonly reason: string;
  /** The one command that clears it, where one exists. */
  readonly remedy?: string;
}

/** The whole report: the worst verdict, and every check that produced it. */
export interface PreflightReport {
  readonly schema: number;
  readonly verdict: "green" | "amber" | "red";
  readonly checks: readonly PreflightCheck[];
}

const VERDICTS: ReadonlySet<string> = new Set(["green", "amber", "red"]);

const RANK = { green: 0, amber: 1, red: 2 } satisfies Record<"green" | "amber" | "red", number>;

/** The worst of a set of verdicts. The CLI's own summary rule, restated (nothing here may import it). */
export function worstVerdict(verdicts: readonly ("green" | "amber" | "red")[]): "green" | "amber" | "red" {
  let seen: "green" | "amber" | "red" = "green";
  for (const v of verdicts) if (RANK[v] > RANK[seen]) seen = v;
  return seen;
}

/**
 * The argv of the preflight the PHONE runs.
 *
 * `--local` is the load-bearing word: the card updates the lead alone (ADR 0016 — a peer is
 * levelled from a terminal), so a peer must never be a reason to refuse the lead's own update, and
 * the member walk runs over the operator's SSH, which a bridge running as a service does not have.
 */
export function preflightCommand(binary: string): string[] {
  return [binary, "update", "--check", "--local", "--json"];
}

/**
 * {@link PreflightCheck} while it is being BUILT field by field — the one place a check is not
 * readonly. A named contract rather than an inline type, so the optional `remedy` is declared where
 * the parser assigns it (the same arrangement `bridge/update-run.ts`'s `DraftRun` uses).
 */
interface DraftCheck {
  id: string;
  verdict: "green" | "amber" | "red";
  reason: string;
  remedy?: string;
}

const asRecord = (value: JsonValue): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;

/**
 * The report inside `stdout`, or null when there is none this build can read as one.
 *
 * The CLI prints JSON and nothing else under `--json`, but a subprocess is still a subprocess: a
 * warning on stdout from something further down would otherwise make the whole document unreadable,
 * so the widest JSON object in the output is taken. A malformed report reads the same as no report,
 * which the caller treats as "the preflight could not run" — never as "nothing is red".
 */
export function parsePreflightReport(stdout: string): PreflightReport | null {
  const text = stdout.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let doc: JsonValue;
  try {
    // SAFETY: `JSON.parse` answers a JSON value, and every field read off it below is validated —
    // the verdicts against a closed set, the checks against their required string fields. Nothing
    // here becomes a path, a command or a credential; it is printed and compared.
    doc = JSON.parse(text.slice(start, end + 1)) as JsonValue;
  } catch {
    return null;
  }
  const rec = asRecord(doc);
  if (rec === null) return null;
  if (rec.schema !== PREFLIGHT_SCHEMA) return null;
  const verdict = rec.verdict;
  if (typeof verdict !== "string" || !VERDICTS.has(verdict)) return null;
  const rawChecks = rec.checks;
  if (!Array.isArray(rawChecks)) return null;
  const checks: PreflightCheck[] = [];
  for (const raw of rawChecks) {
    const c = asRecord(raw);
    if (c === null) return null;
    const { id, reason, remedy } = c;
    const cv = c.verdict;
    if (typeof id !== "string" || typeof reason !== "string") return null;
    if (typeof cv !== "string" || !VERDICTS.has(cv)) return null;
    // Assigned, never conditionally spread: a check with no remedy carries NO such key.
    const parsed: DraftCheck = {
      id,
      // SAFETY: `VERDICTS` holds exactly the three members of the verdict union, and the guard above
      // returned for every string that is not one of them.
      verdict: cv as "green" | "amber" | "red",
      reason,
    };
    if (typeof remedy === "string") parsed.remedy = remedy;
    checks.push(parsed);
  }
  // The phone's payload carries no `pack` — the card is the LEAD's own answer. A report that still
  // has one (an older CLI, or a terminal run read here) folded its members into the top verdict, so
  // dropping the members while keeping that verdict would show a red card with no red row. The
  // verdict is re-derived from the checks that remain. `--local` makes this a belt-and-braces path.
  // SAFETY: `verdict` was checked against `VERDICTS` above, which holds exactly the three members of
  // the union, and the guard there returned for every string that is not one of them.
  const printed = verdict as "green" | "amber" | "red";
  const topLevel = rec.pack === undefined ? printed : worstVerdict(checks.map((c) => c.verdict));
  return { schema: PREFLIGHT_SCHEMA, verdict: topLevel, checks };
}

/** The first red check in `report`, or null. What the refusal NAMES — "unavailable" is not a reason. */
export function firstRed(report: PreflightReport): PreflightCheck | null {
  return report.checks.find((c) => c.verdict === "red") ?? null;
}

/** How long a cached preflight stays fresh. The card polls; the CLI shells out to git and doctor. */
export const PREFLIGHT_TTL_MS = 60_000;

// ── The pack's half of the preflight (M16/03) ────────────────────────────────
//
// Every collie builds a `PreflightCache`, lead or peer, so a peer can answer for ITSELF without an
// SSH session anybody has to hold. It publishes that answer as one additive-optional object beside
// `GET /pack/v1/snapshot`'s body (PACK_PROTOCOL.md §19), the lead's sweep banks it, and the card
// reads the bank. Nothing here dials, spawns or walks members: `--local` is untouched, and the lead
// never asks a peer to check a third machine.

/**
 * The most checks the wire carries for one member, and the id of the check that says so when the
 * rest were dropped.
 *
 * The poll's budget is §10.1's and this must not grow it, so the list is bounded rather than
 * trusted. The report's own `verdict` is carried whole and is never re-derived from the checks that
 * survived — a truncated list can therefore never turn a red member green — and the list is ordered
 * worst-first BEFORE it is cut, so a red member always keeps the reason that made it red.
 */
export const PACK_PREFLIGHT_MAX_CHECKS = 16;
/** The synthetic trailing check. GREEN on purpose: stating a truncation must not invent a finding. */
export const PACK_PREFLIGHT_TRUNCATED_ID = "checks-truncated";

/** One member's own preflight, as it crosses the link and as the lead banks it. */
export interface PeerPreflight {
  /** That member's own top verdict, carried whole — never re-derived from `checks`. */
  readonly verdict: "green" | "amber" | "red";
  /** When that member produced the report, on **its own** clock, epoch ms. Passed through untouched. */
  readonly asOf: number;
  readonly checks: readonly PreflightCheck[];
}

/** Worst first, stably — the order the reasons are read in, and the order truncation keeps. */
export function worstFirst(checks: readonly PreflightCheck[]): readonly PreflightCheck[] {
  return checks.toSorted((a, b) => RANK[b.verdict] - RANK[a.verdict]);
}

/**
 * The check list one member publishes: worst first, capped at {@link PACK_PREFLIGHT_MAX_CHECKS},
 * and **truncation stated rather than silent**.
 *
 * Applied on both ends — the peer caps what it emits, the lead caps what it reads — because a bound
 * that only one side enforces is a bound the other side can be talked out of.
 */
export function packPreflightChecks(checks: readonly PreflightCheck[]): readonly PreflightCheck[] {
  const ordered = worstFirst(checks);
  if (ordered.length <= PACK_PREFLIGHT_MAX_CHECKS) return ordered;
  const kept = ordered.slice(0, PACK_PREFLIGHT_MAX_CHECKS - 1);
  const dropped = ordered.length - kept.length;
  return [
    ...kept,
    {
      id: PACK_PREFLIGHT_TRUNCATED_ID,
      verdict: "green",
      reason: `${dropped} further check${dropped === 1 ? "" : "s"} were not carried over the pack link`,
    },
  ];
}

/** The wire name of the field, and of the header that asks for a fresh one (PACK_PROTOCOL.md §19). */
export const PACK_PREFLIGHT_FIELD = "updatePreflight";

/** What one member publishes beside its snapshot body. `null` ⇒ it has nothing to say, which is unknown. */
export function peerPreflightWire(report: PreflightReport | null, asOf: number | null): PeerPreflight | null {
  if (report === null || asOf === null) return null;
  return {
    verdict: report.verdict,
    asOf,
    // The remedy is deliberately dropped: it is a command for the operator of THAT machine, and the
    // lead's card names a member and a reason, never a shell line to run somewhere else.
    checks: packPreflightChecks(report.checks).map((c) => ({ id: c.id, verdict: c.verdict, reason: c.reason })),
  };
}

/**
 * Read a member's `updatePreflight` off the answer its snapshot rode on.
 *
 * `null` for every shape this build cannot read as a report — absent, half-formed, a verdict outside
 * the closed set — and `null` means **unknown**, never green (§7.1). A peer that has not run its
 * check yet, or whose check could not run, lands here, and the card blocks on it by name.
 */
export function parsePeerPreflight(value: JsonValue): PeerPreflight | null {
  const rec = asRecord(value);
  if (rec === null) return null;
  const field = asRecord(rec[PACK_PREFLIGHT_FIELD] ?? null);
  if (field === null) return null;
  const verdict = field.verdict;
  const asOf = field.asOf;
  if (typeof verdict !== "string" || !VERDICTS.has(verdict)) return null;
  if (typeof asOf !== "number" || !Number.isSafeInteger(asOf) || asOf <= 0) return null;
  const rawChecks = field.checks;
  if (!Array.isArray(rawChecks)) return null;
  const checks: PreflightCheck[] = [];
  for (const raw of rawChecks) {
    const c = asRecord(raw);
    if (c === null) return null;
    const { id, reason } = c;
    const cv = c.verdict;
    if (typeof id !== "string" || typeof reason !== "string") return null;
    if (typeof cv !== "string" || !VERDICTS.has(cv)) return null;
    // SAFETY: `VERDICTS` holds exactly the three members of the verdict union, and the guard above
    // returned for every string that is not one of them.
    checks.push({ id, verdict: cv as "green" | "amber" | "red", reason });
  }
  return {
    // SAFETY: checked against `VERDICTS` above, which holds exactly the three members of the union.
    verdict: verdict as "green" | "amber" | "red",
    asOf,
    checks: packPreflightChecks(checks),
  };
}

// ── The pack's half of the RUN (M16/04) ──────────────────────────────────────

/**
 * The trimmed run record a member publishes beside its snapshot body (PACK_PROTOCOL.md §20).
 *
 * The lead cannot otherwise know a peer is moving or has fallen back: the version alone says only
 * "still behind", and a peer that tried and rolled back looks exactly like a peer that has not
 * started. It rides ALONGSIDE the body for the reason `updatePreflight` does — `body` is the object
 * that machine serves its own browser, and a pack-only fact has no business in the browser's
 * snapshot type — and it carries no pid, no log tail and no recovery command: those are for the
 * operator of THAT machine, and the lead's page names a member, a state and a reason.
 */
export interface PeerRunReport {
  readonly state: UpdateRunState;
  /** The version that run was moving to, as that machine spells it. Never re-derived here. */
  readonly to: string | null;
  /** The run it belongs to, or null. A leg is only matched against the run the lead is driving. */
  readonly runId: string | null;
  readonly reason: string | null;
  /** That machine's own stamp, passed through untouched — nothing here can make an old fact new. */
  readonly updatedAt: number | null;
}

/** The wire name of {@link PeerRunReport}'s field, beside {@link PACK_PREFLIGHT_FIELD} (§20). */
export const PACK_RUN_FIELD = "updateRun";

/** How much of a reason crosses the link. A log tail is that machine's own business, not the pack's. */
export const PACK_RUN_REASON_MAX = 240;

/** What one member publishes. `null` ⇒ it has never run an update, which is nothing to report. */
export function peerRunWire(run: UpdateRun | null): PeerRunReport | null {
  if (run === null) return null;
  return {
    state: run.state,
    to: run.to,
    runId: run.runId ?? null,
    reason: run.reason === undefined ? null : run.reason.slice(0, PACK_RUN_REASON_MAX),
    updatedAt: run.updatedAt,
  };
}

/**
 * Read a member's `updateRun` off the answer its snapshot rode on.
 *
 * `null` for every shape this build cannot read as one, which is the closed reading: a member that
 * reported nothing is a member the lead has learned nothing new about, never a member that
 * succeeded.
 */
export function parsePeerRun(value: JsonValue): PeerRunReport | null {
  const rec = asRecord(value);
  if (rec === null) return null;
  const field = asRecord(rec[PACK_RUN_FIELD] ?? null);
  if (field === null) return null;
  const state = field.state;
  if (typeof state !== "string" || !RUN_STATES.has(state)) return null;
  const { to, runId, reason, updatedAt } = field;
  return {
    // SAFETY: `RUN_STATES` holds exactly the members of `UpdateRunState`, and the guard above
    // returned for every string that is not one of them.
    state: state as UpdateRunState,
    to: typeof to === "string" && to !== "" ? to : null,
    runId: typeof runId === "string" && runId !== "" ? runId : null,
    reason: typeof reason === "string" && reason !== "" ? reason.slice(0, PACK_RUN_REASON_MAX) : null,
    updatedAt: typeof updatedAt === "number" && Number.isSafeInteger(updatedAt) ? updatedAt : null,
  };
}

/** Every member of `UpdateRunState`. Anything else is a member reporting nothing. */
const RUN_STATES: ReadonlySet<string> = new Set<UpdateRunState>([
  "idle",
  "preflight",
  "staging",
  "restarting",
  "verifying",
  "done",
  "rolled-back",
  "stuck",
  "interrupted",
]);

/**
 * A member's verdict as the card reads it. `unknown` is the fourth, and it is not a shade of green:
 * it is "we could not check this machine", which blocks the confirm exactly as a red does.
 */
export type PackVerdict = "green" | "amber" | "red" | "unknown";

/** One row of `GET /api/update/check`'s `pack` array. */
export interface PackUpdateRow {
  readonly name: string;
  /** What that member last reported over the link, or `null` when it has reported none. */
  readonly version: string | null;
  readonly verdict: PackVerdict;
  /** The reason strings of its non-green checks, worst first. A red row always has at least one. */
  readonly reasons: readonly string[];
  /** That member's own stamp for the report, or `null` when there is no report to date. */
  readonly asOf: number | null;
}

/** What the lead knows about one member when it composes a row. All of it banked by the sweep. */
export interface PackMemberFacts {
  readonly name: string;
  readonly version: string | null;
  readonly preflight: PeerPreflight | null;
}

/** The reason strings a report contributes: its non-green checks, worst first. */
function reasonsOf(checks: readonly PreflightCheck[]): string[] {
  return worstFirst(checks)
    .filter((c) => c.verdict !== "green")
    .map((c) => c.reason);
}

/** What the card shows for a member nobody could check. Names the member, because "red" alone is not a reason. */
export function unknownReason(name: string): string {
  return `we could not check ${name}`;
}

/**
 * One row per member, from what the sweep banked and from nothing else.
 *
 * A member with no banked report is `unknown` with the reason that says so — never omitted, and
 * never green. `asOf` is that member's own stamp, passed through untouched: a green from six hours
 * ago and a green from four seconds ago are different claims.
 */
export function packUpdateRows(members: readonly PackMemberFacts[]): PackUpdateRow[] {
  return members.map((m) => {
    if (m.preflight === null) {
      return { name: m.name, version: m.version, verdict: "unknown", reasons: [unknownReason(m.name)], asOf: null };
    }
    const reasons = reasonsOf(m.preflight.checks);
    return {
      name: m.name,
      version: m.version,
      verdict: m.preflight.verdict,
      // A red row with no reason is a defect (M15/03's rule), and truncation cannot cause one — the
      // list is cut worst-first, so a red check is the last thing to go.
      reasons: m.preflight.verdict === "red" && reasons.length === 0 ? [unknownReason(m.name)] : reasons,
      asOf: m.preflight.asOf,
    };
  });
}

const PACK_VERDICTS: ReadonlySet<string> = new Set(["green", "amber", "red", "unknown"]);

/**
 * The `pack` rows inside a `GET /api/update/check` answer, read defensively.
 *
 * The reader is `collie pack update`, over loopback against this collie's own bridge — a different
 * process, possibly a different build, so the body is parsed like any other foreign document. A row
 * this build cannot read whole is DROPPED rather than half-believed; the transcript is then quieter
 * and nothing else changes, because that transcript is a nicety and never a gate.
 */
export function parsePackRows(doc: JsonValue): PackUpdateRow[] {
  const rec = asRecord(doc);
  if (rec === null) return [];
  const rows = rec.pack;
  if (!Array.isArray(rows)) return [];
  const out: PackUpdateRow[] = [];
  for (const raw of rows) {
    const row = asRecord(raw);
    if (row === null) continue;
    const { name, verdict, version, reasons, asOf } = row;
    if (typeof name !== "string" || typeof verdict !== "string" || !PACK_VERDICTS.has(verdict)) continue;
    out.push({
      name,
      version: typeof version === "string" ? version : null,
      // SAFETY: checked against `PACK_VERDICTS` on the line above, which holds exactly the four
      // members of the union, and the guard there skipped every string that is not one of them.
      verdict: verdict as PackVerdict,
      reasons: Array.isArray(reasons) ? reasons.filter((r): r is string => typeof r === "string") : [],
      asOf: typeof asOf === "number" && Number.isSafeInteger(asOf) ? asOf : null,
    });
  }
  return out;
}

/** The merged answer: the worst verdict in the pack, and the machine that produced it. */
export interface MergedUpdateVerdict {
  readonly verdict: PackVerdict;
  /** The member the verdict came from, or `null` when everything is green. */
  readonly member: string | null;
  /** That member's own sentence for it, or `null`. */
  readonly reason: string | null;
  /** Whether the confirm is refused. Red and unknown both refuse; amber never does. */
  readonly blocks: boolean;
}

/**
 * The ONE function the card, the ribbon and `POST /api/update`'s refusal all read (M16/03).
 *
 * The lead's own `preflight.verdict` stays what it is — its own machine's answer, from `--local`.
 * This is the pack-wide gate on top of it, computed with {@link worstVerdict} so a second summary
 * rule cannot come to disagree with the first, and it always names the machine: "red" rendered
 * without a member beside it is a dead end for the operator holding the phone.
 *
 * `unknown` is decided AFTER red and BEFORE amber. A member nobody could check is not a reason to
 * hide a member that is actually red, and it is not a shade of amber either — it blocks.
 */
export function mergedUpdateVerdict(
  lead: PreflightReport | null,
  pack: readonly PackUpdateRow[],
  selfName = "this collie",
): MergedUpdateVerdict {
  const leadRow: PackUpdateRow =
    lead === null
      ? { name: selfName, version: null, verdict: "unknown", reasons: [unknownReason(selfName)], asOf: null }
      : { name: selfName, version: null, verdict: lead.verdict, reasons: reasonsOf(lead.checks), asOf: null };
  const rows = [leadRow, ...pack];
  const red = rows.find((r) => r.verdict === "red");
  if (red !== undefined) return { verdict: "red", member: red.name, reason: red.reasons[0] ?? null, blocks: true };
  const unknown = rows.find((r) => r.verdict === "unknown");
  if (unknown !== undefined) {
    return { verdict: "unknown", member: unknown.name, reason: unknown.reasons[0] ?? null, blocks: true };
  }
  // Everything left is green or amber, which is exactly `worstVerdict`'s domain.
  const verdict = worstVerdict(rows.map((r) => (r.verdict === "amber" ? "amber" : "green")));
  if (verdict === "green") return { verdict: "green", member: null, reason: null, blocks: false };
  const amber = rows.find((r) => r.verdict === "amber");
  return { verdict: "amber", member: amber?.name ?? null, reason: amber?.reasons[0] ?? null, blocks: false };
}

/**
 * The peer's allowance for `X-Pack-Preflight: fresh` (PACK_PROTOCOL.md §19).
 *
 * The header is a **request** for a re-read, not an order, and it is honoured at most once per
 * {@link PREFLIGHT_TTL_MS} — so a phone sitting on the update page cannot make a peer shell out to
 * git and `doctor` on every poll. That is `PreflightCache`'s own TTL doing its job across the link,
 * spelled once here rather than inferred at the call site.
 *
 * One gate per process, which IS "per member": the member is the machine holding the gate.
 */
export class FreshPreflightGate {
  private spentAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly deps: { readonly now: () => number; readonly ttlMs?: number }) {}

  /** Whether a `fresh` request is honoured now. Spends the allowance when it answers `true`. */
  admit(): boolean {
    const now = this.deps.now();
    if (now - this.spentAt < (this.deps.ttlMs ?? PREFLIGHT_TTL_MS)) return false;
    this.spentAt = now;
    return true;
  }
}

/**
 * One tick of the update cadence — the monitor's release check, plus a **peer's** own preflight
 * refresh (M16/03).
 *
 * It rides the two timers `bridge/index.ts` already arms (`UPDATE_FIRST_DELAY_MS`,
 * `UPDATE_INTERVAL_MS` — 6 h) rather than becoming a third timer with a third opinion about how
 * often to shell out. A lead and a solo instance refresh nothing here: the card's own read is what
 * runs their preflight, and it always has been.
 */
export function updateCadenceTick(a: {
  readonly isPeer: boolean;
  readonly checkRelease: () => void;
  readonly refreshPreflight?: () => void;
}): void {
  a.checkRelease();
  if (a.isPeer) a.refreshPreflight?.();
}

/** Running `collie update --check --json` once. `ok` is the exit code being 0 or {@link EXIT.FAIL} —
 *  a red preflight EXITS NON-ZERO and still prints a perfectly good report, so the caller reads the
 *  document either way and only a missing document means "could not run". */
export type PreflightRunner = () => Promise<{ readonly stdout: string }>;

/**
 * The bridge's cached view of `collie update --check --json`.
 *
 * Cached because the card polls it and the check itself is not cheap — it asks git for the remote's
 * tags and runs `doctor`. One run per {@link PREFLIGHT_TTL_MS} at most, plus whatever the update
 * route forces before it starts anything: the client's disabled button is a courtesy, the server's
 * own fresh run is the gate.
 *
 * Concurrent callers await the SAME run, exactly as {@link import("./update.ts").UpdateMonitor}
 * de-dupes its release check — two phones polling must not become two subprocesses.
 */
export class PreflightCache {
  private value: PreflightReport | null = null;
  private at = Number.NEGATIVE_INFINITY;
  private running: Promise<PreflightReport | null> | null = null;

  constructor(
    private readonly deps: {
      readonly run: PreflightRunner;
      readonly now: () => number;
      readonly ttlMs?: number;
    },
  ) {}

  /**
   * What the cache holds **right now**, without running anything. `null` until a run has landed.
   *
   * The pack's read (`GET /pack/v1/snapshot`) takes this path and not {@link PreflightCache.get}:
   * the lead's sweep runs on a strict per-poll budget (PACK_PROTOCOL.md §10.1), and a stale entry
   * that shelled out to git mid-sweep would turn a healthy member unreachable. The peer's own 6 h
   * refresh is what keeps this warm; `asOf` is what says how warm.
   */
  peek(): { readonly report: PreflightReport | null; readonly at: number } | null {
    return this.at === Number.NEGATIVE_INFINITY ? null : { report: this.value, at: this.at };
  }

  /** The report, fresh within the TTL. `force` re-runs it now — what the update route does. */
  get(force = false): Promise<PreflightReport | null> {
    const ttl = this.deps.ttlMs ?? PREFLIGHT_TTL_MS;
    if (!force && this.deps.now() - this.at < ttl) return Promise.resolve(this.value);
    if (this.running) return this.running;
    this.running = this.runOnce().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runOnce(): Promise<PreflightReport | null> {
    let report: PreflightReport | null;
    try {
      report = parsePreflightReport((await this.deps.run()).stdout);
    } catch {
      // The subprocess could not be started at all. That is "no report", which refuses the update —
      // never "nothing is red".
      report = null;
    }
    this.value = report;
    this.at = this.deps.now();
    return report;
  }
}

// ── The start verdict ────────────────────────────────────────────────────────

/** What `POST /api/update` decided. `start` carries what the server is about to install. */
export type UpdateStartVerdict =
  | { readonly kind: "start"; readonly to: string; readonly major: boolean }
  | { readonly kind: "refuse"; readonly status: number; readonly body: ApiErrorBody };

const refuse = (status: number, code: ErrorCode, detail?: ApiErrorDetail): UpdateStartVerdict => ({
  kind: "refuse",
  status,
  body: apiError(code, detail),
});

/** The request body this route accepts, after parsing. Everything else is a 400. */
export interface UpdateStartRequest {
  readonly confirm: boolean;
  /** The version the operator READ about on the card, when the client sent one. */
  readonly target: string | null;
  /** The second consent, and only a major crossing needs it (ADR 0020). */
  readonly major: boolean;
}

/** Parse an untrusted body. `null` when it is not an object — the caller answers 400. */
export function parseUpdateStartRequest(body: JsonValue): UpdateStartRequest | null {
  const rec = asRecord(body);
  if (rec === null) return null;
  const target = rec.target;
  return {
    confirm: rec.confirm === true,
    target: typeof target === "string" && target.trim() !== "" ? target.trim() : null,
    major: rec.major === true,
  };
}

/** Everything the verdict is decided from — all of it read before the request arrived. */
export interface UpdateStartState {
  /** The running version. */
  readonly current: string;
  /** What a ROUTINE update would install (never crosses a major), or null. */
  readonly latest: string | null;
  /** The newest release above the running major, or null (ADR 0020). */
  readonly majorAvailable: string | null;
  /** The run record on disk, resolved. */
  readonly run: UpdateRun | null;
  /** Whether the updater's lock is held by a live process. */
  readonly lockHeld: boolean;
  /** The freshly-run preflight, or null when it could not be run at all. */
  readonly preflight: PreflightReport | null;
  /**
   * Every member's row, as the sweep banked it (M16/03). Absent ⇒ solo, which is `[]` and green.
   *
   * One confirm covers the pack, so the gate covers the pack: a member that is red — or that nobody
   * could check — refuses the run here, with its own name and its own sentence, exactly as the card
   * showed before the operator tapped.
   */
  readonly pack?: readonly PackUpdateRow[];
}

/**
 * Whether this request starts an update, and if not, exactly why not.
 *
 * The order is the order the refusals matter in, and it is not arbitrary:
 *
 *  1. **No confirm, no update.** One tap plus one confirm is the whole contract; a body without the
 *     confirm is a client bug or a forged request, and either way nothing should move.
 *  2. **A run is already going.** This is what makes a double tap idempotent (spec 04's lock): the
 *     second POST is a refusal that NAMES the run, never a second updater.
 *  3. **The preflight.** Re-run by the server on every start, whatever the client believed — the
 *     disabled button is a courtesy and this is the gate. A report that could not be produced is a
 *     refusal too: "we could not check" is not "nothing is red".
 *  4. **The major crossing.** Asked for by name and consented to by name, or refused with the words
 *     that say so. It must not be possible to cross a major by tapping the button you tapped last
 *     week.
 *  5. **The target the operator read.** A stale card must not consent to a version nobody read
 *     about, so a target that no longer matches what this collie would install is refused.
 */
export function updateStartVerdict(req: UpdateStartRequest, state: UpdateStartState): UpdateStartVerdict {
  if (!req.confirm) return refuse(400, "update.confirm_required");

  const running = state.run !== null && inFlight(state.run.state);
  if (running || state.lockHeld) {
    return refuse(409, "update.in_progress", { state: state.run?.state ?? "staging" });
  }

  if (state.preflight === null) return refuse(503, "update.preflight_unavailable");
  const red = firstRed(state.preflight);
  if (red !== null) {
    // The check's own id and its own sentence, both — the phone shows the reason in place of a
    // generic "unavailable", and a red preflight has to be legible without leaving the phone.
    return refuse(412, "update.preflight_red", { check: red.id, reason: red.reason });
  }

  // The pack's half of the same gate, decided by the ONE merge function the card and the ribbon
  // read (M16/03). The lead's own red is refused above and names its CHECK; a member's is named by
  // MACHINE, because that is the only handle the operator holding a phone has on it. An unknown
  // member blocks here too — "we could not check attic" is not "attic is fine".
  const merged = mergedUpdateVerdict(state.preflight, state.pack ?? []);
  if (merged.blocks) {
    return refuse(412, "update.preflight_red", {
      check: merged.member ?? "the pack",
      reason: merged.reason ?? "the pack preflight could not be read",
    });
  }

  const { majorAvailable } = state;
  if (!req.major && req.target !== null && majorAvailable !== null && req.target === majorAvailable) {
    return refuse(412, "update.major_confirm_required", { version: majorAvailable });
  }

  const would = req.major ? majorAvailable : state.latest;
  if (would === null || compareSemver(would, state.current) <= 0) {
    return refuse(409, "update.none_available");
  }
  if (req.target !== null && req.target !== would) {
    return refuse(409, "update.target_mismatch", { asked: req.target, would });
  }
  return { kind: "start", to: would, major: req.major };
}

// ── The handoff ──────────────────────────────────────────────────────────────

/**
 * The command that starts an update from the bridge, detached from the bridge.
 *
 * It is `collie update` — the operator's own verb, spawned as the current binary, so the phone's
 * button and the terminal take the identical path through staging and the handoff to the detached
 * runner (M15/04). The bridge adds nothing to that path and knows nothing about it.
 *
 * **What it does add is one hop out of its own cgroup.** `collie update` stages first and hands off
 * second, and the handoff is what restarts this very service — so a staging child left inside the
 * bridge's unit would be killed by the restart it asked for. `systemd-run --user --collect` moves it
 * into a transient unit of its own; `setsid` at least leaves the process group where there is no
 * user manager; a bare spawn is the last resort on a host with neither. That ladder is deliberately
 * the same three tiers as `cli/update-run.ts`'s `launchPlan`, for the same reasons written there —
 * it is restated rather than imported because nothing in `bridge/` may import from `cli/`.
 */
export function updateStartCommand(a: {
  readonly platform: string;
  readonly binary: string;
  readonly major: boolean;
  readonly stamp: string;
  readonly hasSystemdRun: boolean;
  readonly hasSetsid: boolean;
}): string[] {
  const verb = a.major ? ["update", "--major"] : ["update"];
  if (a.platform === "linux" && a.hasSystemdRun) {
    return ["systemd-run", "--user", "--collect", "--unit", `collie-api-update-${a.stamp}`, a.binary, ...verb];
  }
  if (a.hasSetsid) return ["setsid", a.binary, ...verb];
  return [a.binary, ...verb];
}
