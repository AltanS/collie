import type { JsonObject, JsonValue } from "./json.ts";
import { apiError, type ApiErrorBody, type ApiErrorDetail, type ErrorCode } from "./error-codes.ts";
import { compareSemver } from "./update.ts";
import { inFlight, type UpdateRun } from "./update-run.ts";

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
  return {
    schema: PREFLIGHT_SCHEMA,
    // SAFETY: as above — checked against the same closed set one line after it was read.
    verdict: verdict as "green" | "amber" | "red",
    checks,
  };
}

/** The first red check in `report`, or null. What the refusal NAMES — "unavailable" is not a reason. */
export function firstRed(report: PreflightReport): PreflightCheck | null {
  return report.checks.find((c) => c.verdict === "red") ?? null;
}

/** How long a cached preflight stays fresh. The card polls; the CLI shells out to git and doctor. */
export const PREFLIGHT_TTL_MS = 60_000;

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
