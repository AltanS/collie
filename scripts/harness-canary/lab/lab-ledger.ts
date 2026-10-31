// The nightly lab's own ledger (M56 spec 10): one row per (harness, version), written once.
//
// WHY ONE ROW AND NEVER TWO. A lab run spends the person's Claude subscription (model turns) and
// minutes of the machine. A row says "this pair was run". A pair with a row is never run again,
// whatever the result: pass, fail, failed or walk-only. The row is written BEFORE the first paid
// step as `running`, and finished after. A run that dies in between leaves `running`, and the next
// read turns it into `failed` (interrupted). Nothing in this file ever removes a row, with one exception:
// a run that NAMES its version by hand (`--version`) may take a `failed` row over (see `shouldRun`).
// `failed` is "the lab could not finish, no verdict", so the pair was never judged. `pass` and `fail` stay final.
//
// The file is `~/.local/state/collie-harness-lab/ledger.json`. The environment variable
// `COLLIE_HARNESS_LAB_LEDGER` names another path. The ledger is not the verified-versions ledger in
// web/src/lib/harness/ (scripts/harness-canary/ledger.ts writes that one).

import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { asJsonNumber, asJsonObject, asJsonString, parseJson, type JsonObject, type JsonValue } from "../../../web/src/lib/json";

export const LEDGER_ENV = "COLLIE_HARNESS_LAB_LEDGER";

/**
 * How a pair ended.
 *  - `running`: claimed, not finished. Never final: the next read turns an old one into `failed`.
 *  - `pass`: the full lab ran and passed.
 *  - `fail`: the lab ran and found drift. An issue file was written.
 *  - `failed`: the lab could not finish (install, start, crash, timeout). No verdict on the readers.
 *  - `walk-only`: the harness has no profile, so only the walk ran, and it passed.
 */
export const RESULTS = ["running", "pass", "fail", "failed", "walk-only"] as const;
export type LabResult = (typeof RESULTS)[number];

export interface LabRow {
  readonly harness: string;
  readonly version: string;
  /** The day the run started, `YYYY-MM-DD`. */
  readonly date: string;
  readonly result: LabResult;
  /** The run log, an absolute path. */
  readonly log: string;
  /** One line: why it failed, or what passed. */
  readonly note?: string | undefined;
  /** The verdict the operator was told about, so one version never tells twice (M44 spec 06). */
  readonly notified?: string | undefined;
  /** When the row was claimed, epoch milliseconds. Only `running` needs it. */
  readonly startedAt?: number | undefined;
  /** The process that holds a `running` row. A dead pid means the run died, and the sweep settles the row. */
  readonly pid?: number | undefined;
}

export interface LabLedger {
  readonly rows: readonly LabRow[];
}

export class LedgerError extends Error {
  constructor(path: string, problem: string) {
    super(`harness lab ledger ${path}: ${problem}`);
    this.name = "LedgerError";
  }
}

/** A `running` row older than this is a run that died. */
export const STALE_RUNNING_MS = 3 * 60 * 60 * 1000;

const VERSION = /^\d+\.\d+\.\d+$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

export function ledgerPath(env: Readonly<Record<string, string | undefined>> = process.env, home: string = homedir()): string {
  const named = env[LEDGER_ENV];
  return named !== undefined && named.length > 0 ? named : join(home, ".local", "state", "collie-harness-lab", "ledger.json");
}

function parseRow(path: string, value: JsonValue | undefined, index: number): LabRow {
  const node = asJsonObject(value);
  const at = `rows[${String(index)}]`;
  if (node === undefined) throw new LedgerError(path, `${at} is not an object`);
  const harness = asJsonString(node.harness);
  const version = asJsonString(node.version);
  const date = asJsonString(node.date);
  const result = RESULTS.find((word) => word === node.result);
  const log = asJsonString(node.log);
  if (harness === undefined || harness.length === 0) throw new LedgerError(path, `${at}.harness is missing`);
  if (version === undefined || !VERSION.test(version)) throw new LedgerError(path, `${at}.version is not x.y.z`);
  if (date === undefined || !DAY.test(date)) throw new LedgerError(path, `${at}.date is not YYYY-MM-DD`);
  if (result === undefined) throw new LedgerError(path, `${at}.result is not one of ${RESULTS.join(", ")}`);
  if (log === undefined) throw new LedgerError(path, `${at}.log is missing`);
  return { harness, version, date, result, log, note: asJsonString(node.note), notified: asJsonString(node.notified), startedAt: asJsonNumber(node.startedAt), pid: asJsonNumber(node.pid) };
}

/**
 * The ledger at `path`. A missing file is an empty ledger. A file that is there and cannot be read is
 * an error, never an empty ledger: an empty one would run every pair again, and each run costs.
 */
export function readLedger(path: string): LabLedger {
  if (!existsSync(path)) return { rows: [] };
  const text = readFileSync(path, "utf8");
  const root = asJsonObject(parseJson(text));
  const rows = root?.rows;
  if (root === undefined || !Array.isArray(rows)) throw new LedgerError(path, 'expected { "rows": [ ... ] }');
  return { rows: rows.map((row, i) => parseRow(path, row, i)) };
}

function rowJson(row: LabRow): JsonObject {
  const out: JsonObject = { harness: row.harness, version: row.version, date: row.date, result: row.result, log: row.log };
  if (row.note !== undefined) out.note = row.note;
  if (row.notified !== undefined) out.notified = row.notified;
  if (row.startedAt !== undefined) out.startedAt = row.startedAt;
  if (row.pid !== undefined) out.pid = row.pid;
  return out;
}

/** Writes through a temporary file and a rename, so a crash leaves the old ledger or the new one. */
export function writeLedger(path: string, ledger: LabLedger): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ rows: ledger.rows.map(rowJson) }, null, 2)}\n`);
  renameSync(temp, path);
}

export function findRow(ledger: LabLedger, harness: string, version: string): LabRow | undefined {
  return ledger.rows.find((row) => row.harness === harness && row.version === version);
}

/**
 * The stop rule: a pair with any row, in any result, is skipped. The one exception: a run that names the
 * version by hand (`named`) runs a pair whose row is `failed` again, because `failed` is no verdict. A
 * `running` row, a `pass`, a `fail` and a `walk-only` stay final. An unnamed run never reruns anything.
 */
export function shouldRun(ledger: LabLedger, harness: string, version: string, named = false): boolean {
  const row = findRow(ledger, harness, version);
  if (row === undefined) return true;
  return named && row.result === "failed";
}

export interface Expired {
  readonly ledger: LabLedger;
  readonly moved: number;
}

/** Old `running` rows become `failed`. Nothing else changes. The result says whether any row moved. */
export function expireStale(ledger: LabLedger, now: number): Expired {
  let moved = 0;
  const rows = ledger.rows.map((row): LabRow => {
    if (row.result !== "running") return row;
    const started = row.startedAt ?? 0;
    if (now - started <= STALE_RUNNING_MS) return row;
    moved++;
    return { ...row, result: "failed", note: "interrupted: the run never wrote its end" } satisfies LabRow;
  });
  return { ledger: { rows }, moved };
}

/** The ledger, with stale rows settled, and written back when one moved. */
export function loadLedger(path: string, now: number): LabLedger {
  const { ledger, moved } = expireStale(readLedger(path), now);
  if (moved > 0) writeLedger(path, ledger);
  return ledger;
}

/** A lock a crashed claim left behind is older than this. */
const STALE_LOCK_MS = 5 * 60 * 1000;

function takeLock(lock: string, now: number): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lock);
      return true;
    } catch {
      let age = 0;
      try {
        age = now - statSync(lock).mtimeMs;
      } catch {
        continue;
      }
      if (age <= STALE_LOCK_MS) return false;
      rmSync(lock, { recursive: true, force: true });
    }
  }
  return false;
}

/**
 * Take a pair: write its `running` row. False when the pair already has a row (another run took it,
 * or an earlier run finished it), and nothing is written. `named` lets a `failed` row be taken again (`shouldRun`). Call it before the first paid step.
 */
export function claim(path: string, harness: string, version: string, today: string, log: string, now: number, pid: number = process.pid, named = false): boolean {
  if (!VERSION.test(version)) throw new LedgerError(path, `"${version}" is not x.y.z`);
  // A lock directory makes read-then-write one step: two runs on the same pair cannot both claim it.
  // A run that finds the lock held takes it as "someone else has this pair" and does nothing.
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  if (!takeLock(lock, now)) return false;
  try {
    const ledger = loadLedger(path, now);
    if (!shouldRun(ledger, harness, version, named)) return false;
    // A named rerun takes the `failed` row over: one row per pair, now `running` again.
    const others = ledger.rows.filter((row) => row.harness !== harness || row.version !== version);
    writeLedger(path, { rows: [...others, { harness, version, date: today, result: "running", log, startedAt: now, pid }] });
    return true;
  } finally {
    rmdirSync(lock);
  }
}

/** Finish a claimed pair. Throws when the pair was never claimed: a result needs a claim. */
export function settle(path: string, harness: string, version: string, patch: { readonly result: Exclude<LabResult, "running">; readonly note?: string; readonly log?: string }): LabRow {
  const ledger = readLedger(path);
  const row = findRow(ledger, harness, version);
  if (row === undefined) throw new LedgerError(path, `${harness} ${version} was never claimed`);
  // A settled row has no start time: only a claim needs one.
  const { startedAt, pid, ...kept } = row;
  void startedAt;
  void pid;
  const next: LabRow = { ...kept, result: patch.result, note: patch.note ?? kept.note, log: patch.log ?? kept.log };
  writeLedger(path, { rows: ledger.rows.map((candidate) => (candidate === row ? next : candidate)) });
  return next;
}

/** Remember the verdict told to the operator for a pair. */
export function markNotified(path: string, harness: string, version: string, verdict: string): void {
  const ledger = readLedger(path);
  const row = findRow(ledger, harness, version);
  if (row === undefined) throw new LedgerError(path, `${harness} ${version} has no row`);
  const next: LabRow = { ...row, notified: verdict };
  writeLedger(path, { rows: ledger.rows.map((candidate) => (candidate === row ? next : candidate)) });
}
