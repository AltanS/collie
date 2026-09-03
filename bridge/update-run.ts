import { readFileSync } from "node:fs";
import { join } from "node:path";

// The update RUN record: `<state dir>/update.json`, written by the detached updater and read by
// everybody else (M15/04).
//
// ── WHY THE SHAPE LIVES IN `bridge/` ─────────────────────────────────────────
// The writer is `cli/update-run.ts` and the readers are the bridge's update snapshot and the standby
// door. `cli/` may import from `bridge/`; nothing in `bridge/` may import from `cli/`. So the record,
// its parser and the staleness rule live here — the same reason `bridge/version.ts` owns the version
// string both sides print. One definition, never two that agree today.
//
// ── WHY THERE IS A FILE AT ALL ───────────────────────────────────────────────
// An update restarts the bridge, so the process that reports on it cannot be the process being
// restarted. The runner writes; the bridge reads at startup and reports what it finds, instead of
// coming up `idle` and telling the phone nothing happened. That symptom — tap update, the app goes
// blank, comes back claiming there was no update — is the whole reason this file is on disk.

/** The record's schema. Bumped when a field changes meaning; a reader that does not know it declines. */
export const UPDATE_RUN_SCHEMA = 1;

/** `<state dir>/update.json` — the record. */
export const UPDATE_RUN_FILENAME = "update.json";
/** `<state dir>/update.lock` — the pid-and-timestamp lock. One run at a time. */
export const UPDATE_LOCK_FILENAME = "update.lock";

export const updateRunPath = (stateDir: string): string => join(stateDir, UPDATE_RUN_FILENAME);
export const updateLockPath = (stateDir: string): string => join(stateDir, UPDATE_LOCK_FILENAME);

/**
 * Where a run is.
 *
 * `done`, `rolled-back`, `stuck` and `interrupted` are terminal. `idle` is both the start and where
 * an aborted preflight or staging returns to — nothing had moved yet, so there is nothing to report
 * beyond the reason.
 */
export type UpdateRunState =
  | "idle"
  | "preflight"
  | "staging"
  | "restarting"
  | "verifying"
  | "done"
  | "rolled-back"
  | "stuck"
  | "interrupted";

const STATES: ReadonlySet<string> = new Set<UpdateRunState>([
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

/** The states in which a run is still being driven by somebody. Only these can go stale. */
const IN_FLIGHT: ReadonlySet<UpdateRunState> = new Set<UpdateRunState>([
  "preflight",
  "staging",
  "restarting",
  "verifying",
]);

/** Is `state` one somebody is supposed to still be driving? */
export const inFlight = (state: UpdateRunState): boolean => IN_FLIGHT.has(state);

/**
 * How long an in-flight record may sit untouched before a dead updater's marker stops meaning
 * anything. Ten minutes covers a slow build on slow hardware with room to spare; past it, with no
 * live updater pid, the run is over and nobody is driving it.
 */
export const STALE_AFTER_MS = 10 * 60 * 1000;

/** The record, exactly as it is on disk. */
export interface UpdateRun {
  readonly schema: number;
  readonly state: UpdateRunState;
  /** The version directory the run started from, or null when there was none to name. */
  readonly from: string | null;
  /** The version directory the run is going to. */
  readonly to: string | null;
  readonly startedAt: number;
  readonly updatedAt: number;
  /** The updater's pid — what the lock and the staleness rule ask the process table about. */
  readonly pid: number;
  /** How many rollbacks this run has made. `0` on the way forward, `1` after the one rollback. */
  readonly attempt: number;
  /** Why the run is where it is, when that needs a sentence. */
  readonly reason?: string;
  /** A bounded, credential-scrubbed tail of the service log, recorded on a failure. */
  readonly logTail?: string;
  /** The command the operator runs by hand — carried only by `stuck`. */
  readonly recovery?: string;
}

/** The lock file's contents: who holds it and since when. */
export interface UpdateLock {
  readonly pid: number;
  readonly at: number;
}

const finite = (value: number | undefined, fallback: number): number =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

/**
 * The record in `text`, or null when there is none this build can read as one.
 *
 * A malformed record reads the same as a missing one, on purpose: both mean "no evidence of a run",
 * and a reader that guessed at half a document would report a state nobody was ever in. A record
 * from a schema this build does not know is declined for the same reason.
 */
export function parseUpdateRun(text: string | null): UpdateRun | null {
  if (text === null) return null;
  let doc: {
    schema?: number;
    state?: string;
    from?: string | null;
    to?: string | null;
    startedAt?: number;
    updatedAt?: number;
    pid?: number;
    attempt?: number;
    reason?: string;
    logTail?: string;
    recovery?: string;
  };
  try {
    // SAFETY: `JSON.parse` answers a JSON value, and every field read off it below is either
    // validated (`state` against the closed set, the numbers through `Number.isFinite`) or only ever
    // printed. Nothing here becomes a path, a command or a credential.
    doc = JSON.parse(text) as { schema?: number };
  } catch {
    return null;
  }
  if (finite(doc.schema, 0) !== UPDATE_RUN_SCHEMA) return null;
  const state = doc.state ?? "";
  if (!STATES.has(state)) return null;
  // Assigned, never conditionally spread: a record without a reason must carry NO such key rather
  // than one whose value is `undefined`.
  const run: DraftRun = {
    schema: UPDATE_RUN_SCHEMA,
    // SAFETY: `STATES` holds exactly the members of `UpdateRunState`, and the guard above returned
    // for every string that is not one of them.
    state: state as UpdateRunState,
    from: doc.from ?? null,
    to: doc.to ?? null,
    startedAt: finite(doc.startedAt, 0),
    updatedAt: finite(doc.updatedAt, 0),
    pid: finite(doc.pid, 0),
    attempt: finite(doc.attempt, 0),
  };
  if (doc.reason !== undefined) run.reason = doc.reason;
  if (doc.logTail !== undefined) run.logTail = doc.logTail;
  if (doc.recovery !== undefined) run.recovery = doc.recovery;
  return run;
}

/**
 * {@link UpdateRun} while it is being BUILT field by field — the one place the record is not
 * readonly. A named contract rather than a mapped type, so the optional fields are declared here
 * where the parser assigns them.
 */
interface DraftRun {
  schema: number;
  state: UpdateRunState;
  from: string | null;
  to: string | null;
  startedAt: number;
  updatedAt: number;
  pid: number;
  attempt: number;
  reason?: string;
  logTail?: string;
  recovery?: string;
}

/** The lock in `text`, or null. Same posture as {@link parseUpdateRun}: half a lock is no lock. */
export function parseUpdateLock(text: string | null): UpdateLock | null {
  if (text === null) return null;
  let doc: { pid?: number; at?: number };
  try {
    // SAFETY: as above — a parsed JSON document whose two numeric fields are both range-checked
    // before use, and neither ever leaves this module as anything but a number.
    doc = JSON.parse(text) as { pid?: number; at?: number };
  } catch {
    return null;
  }
  const pid = finite(doc.pid, 0);
  if (pid <= 0) return null;
  return { pid, at: finite(doc.at, 0) };
}

/**
 * **The one staleness rule**, and it covers the killed updater, the rebooted host and the lock left
 * behind by a crash in a single sentence: an in-flight record older than ten minutes whose updater
 * pid is not alive is `interrupted`.
 *
 * Both halves are required. A live pid means the run is simply slow — a big build on a small
 * machine — and killing it off after ten minutes would be inventing a failure. A young record with a
 * dead pid means the updater has only just gone, and a reader that raced the writer's own rename
 * would report an interruption that never happened.
 */
export function readsAsInterrupted(run: UpdateRun, now: number, pidAlive: boolean): boolean {
  if (!inFlight(run.state)) return false;
  if (pidAlive) return false;
  return now - run.updatedAt >= STALE_AFTER_MS;
}

/**
 * `run` as of `now` — the record itself, or the `interrupted` reading of it. Every reader goes
 * through this, so the bridge, the standby door and `collie update --status` can never disagree
 * about whether a stale marker is still a run.
 */
export function resolveUpdateRun(run: UpdateRun, now: number, pidAlive: boolean): UpdateRun {
  if (!readsAsInterrupted(run, now, pidAlive)) return run;
  return {
    ...run,
    state: "interrupted",
    updatedAt: now,
    reason: `the updater (pid ${run.pid}) is gone and the run has not moved since ${new Date(run.updatedAt).toISOString()}`,
  };
}

/** Is there a live process under `pid`? Signal 0 asks without delivering anything. */
export function pidIsAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // EPERM (somebody else's process) is a live pid too, but it cannot be OUR updater — a run this
    // machine started is owned by this user — so treating it as gone is the honest answer here.
    return false;
  }
}

/**
 * Whether the updater's lock is held by a process that is still alive.
 *
 * The bridge's half of spec 04's lock, and the whole of what `POST /api/update` needs from it: not
 * who holds it or since when, only whether starting a second updater would be starting a second
 * updater. A lock file left behind by a dead process is NOT held — the same reading
 * {@link readsAsInterrupted} takes of the record beside it, so the two can never disagree about
 * whether a run is still a run.
 */
export function updateLockHeld(
  stateDir: string,
  alive: (pid: number) => boolean = pidIsAlive,
): boolean {
  let text: string | null;
  try {
    text = readFileSync(updateLockPath(stateDir), "utf8");
  } catch {
    return false;
  }
  const lock = parseUpdateLock(text);
  return lock !== null && alive(lock.pid);
}

/**
 * The record on disk as of now, resolved — for the bridge, which reads it at startup and on every
 * update snapshot. Synchronous and tiny: one small file, read at most once per snapshot poll.
 */
export function readUpdateRun(
  stateDir: string,
  now: () => number = Date.now,
  alive: (pid: number) => boolean = pidIsAlive,
): UpdateRun | null {
  let text: string | null;
  try {
    text = readFileSync(updateRunPath(stateDir), "utf8");
  } catch {
    return null;
  }
  const run = parseUpdateRun(text);
  return run === null ? null : resolveUpdateRun(run, now(), alive(run.pid));
}
