// The browser leg's nightly runner. It runs the leg on origin/main once per tuple, and a person or a
// ritual starts it:
//
//     bun web/e2e/rig/nightly.ts --plan     # what would run; spends nothing, writes nothing
//     bun web/e2e/rig/nightly.ts            # run the leg if this tuple has no row yet
//
// Bun and node builtins only. It runs from a checkout with no node_modules, and it never writes into
// the checkout it was started from: the legs run in a clone of its own (default
// ~/.cache/collie-lab/browser-leg-nightly/clone), detached at the main commit of the tuple.
//
// THREE LEGS, ONE RUN. The solo leg (playwright.config.ts) runs first, the crew leg (crew.config.ts,
// a lead and a member) after it, and the core solo leg (playwright.config.ts again, on herdr-core through
// COLLIE_RIG_MUX=herdr-core, M78) last, all in the same run and under the same row. The crew leg and
// the core leg each have a rig state of their own beside the solo one (`<root>/crew-state`,
// `<root>/core-state`, through COLLIE_RIG_STATE, the name rig-lib.ts reads for all), so the legs share no
// folder, Herdr home, port or socket; the previous rig is brought down before the next one comes up. If
// the solo leg could not start (it wrote no table), the later legs are not run. If the solo leg ran and
// failed, the later legs still run, for a full picture of the tuple.
//
// THE TUPLE is (collie main sha, Claude Code version, pi version, omp version, hc version). The versions
// come from the binaries bins.ts names, and `hc --version` for the herdr-core command line. The ledger (~/.local/state/collie-browser-leg/ledger.json) keeps one row
// per tuple, and a tuple with a row is never run again, whatever the result. The rules are the harness
// lab's (scripts/harness-canary/lab/lab-ledger.ts):
//   - a `running` row is written BEFORE the first paid step (before the clone, so a crash anywhere
//     leaves a row);
//   - a `running` row whose run died (its pid is gone, or it is older than STALE_RUNNING_MS) becomes
//     `failed` on the next start;
//   - a run that cannot finish writes `failed`; a run that finds a case broken writes `fail`;
//   - nothing in this file removes a row. A person reruns a tuple by deleting its row.
// One `running` row that is alive also holds the line for every other tuple, so two runs never share
// the clone or the rig.
//
// A CANNOT-START case costs nothing, writes no row and appends one line to
// ~/.local/state/collie-browser-leg/notify.log: a Claude login with under 25 minutes left (only when
// Claude runs live: claudeReplays), no herdr,
// bun or git, under 8 GB of free memory, no key file, an unreadable binary, an unreachable remote or an
// unreadable ledger. `--plan` shows the same blockers and writes nothing.
//
// THE KEY. COLLIE_RIG_KEY_FILE comes from this process's own environment and goes on to the leg as it
// is. This file checks that the path names a readable file, and nothing else about it. It never reads,
// prints or copies the key.
//
// EXIT CODES. 0: the leg passed, or there was nothing to do. 1: a case failed. 2: the run could not
// finish (it could not start, a step broke, or a case was not reached or not applicable, which proves
// nothing).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, appendFileSync, closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";

import { asJsonNumber, asJsonObject, asJsonString, parseJson, type JsonObject, type JsonValue } from "../../src/lib/json";
import { BIN } from "./bins";

// ── the tuple and the ledger ─────────────────────────────────────────────────────────────────────

export const HARNESS_IDS = ["claude", "pi", "omp"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export interface Tuple {
  /** The full sha of origin/main. */
  readonly sha: string;
  readonly claude: string;
  readonly pi: string;
  readonly omp: string;
  /** The herdr-core command line's version, from `hc --version` (`hc 0.1.14`). Rows from before the core leg read `none`. */
  readonly hc: string;
}

/** The ledger word for a row written before the tuple carried the hc version. */
export const HC_NONE = "none";

/** The versions the tuple reads from a binary: the three harnesses, and `hc`. */
export type VersionId = HarnessId | "hc";

/**
 * How a tuple ended.
 *  - `running`: claimed, not finished. Never final: the next start turns an old one into `failed`.
 *  - `pass`: every case of every harness passed, in the solo leg, the crew leg and the core leg.
 *  - `fail`: a leg ran and at least one case failed (the core leg counts like the others).
 *  - `failed`: the run could not finish, or finished without proving every case (not reached, n/a), in either leg.
 */
export const RESULTS = ["running", "pass", "fail", "failed"] as const;
export type Result = (typeof RESULTS)[number];

export const VERDICTS = ["pass", "fail", "not reached", "n/a"] as const;
export type Verdict = (typeof VERDICTS)[number];
export interface Counts {
  pass: number;
  fail: number;
  "not reached": number;
  "n/a": number;
}
export interface Verdicts {
  claude: Counts;
  pi: Counts;
  omp: Counts;
}

export interface Row extends Tuple {
  /** The day the run started, `YYYY-MM-DD`, UTC. */
  readonly date: string;
  readonly result: Result;
  /** The run log, an absolute path. */
  readonly log: string;
  /** The solo leg's results folder, an absolute path. */
  readonly results?: string | undefined;
  /** The solo leg's table.md, an absolute path. */
  readonly table?: string | undefined;
  /** The crew leg's results folder. Rows written before the crew leg existed have none. */
  readonly crewResults?: string | undefined;
  /** The crew leg's table.md. Rows written before the crew leg existed have none. */
  readonly crewTable?: string | undefined;
  /** The core solo leg's results folder. Rows written before the core leg existed have none. */
  readonly coreResults?: string | undefined;
  /** The core solo leg's table.md. Rows written before the core leg existed have none. */
  readonly coreTable?: string | undefined;
  /** The counts of all legs added up per harness (the crew leg's cases run under Claude). */
  readonly verdicts?: Verdicts | undefined;
  /**
   * The model tier pi, omp and Claude ran on in each leg (M67, replay/tier.ts), from each leg's model.json:
   * `solo: pi replay, omp live+record, claude replay; crew: pi replay, claude replay; core: ...`. Rows from before
   * M67 have none, and rows from before spec 07 name no Claude tier (Claude was live then).
   */
  readonly tiers?: string | undefined;
  /** One line: why it failed, or what passed. */
  readonly note?: string | undefined;
  /** When the row was claimed, epoch milliseconds. Only `running` needs it. */
  readonly startedAt?: number | undefined;
  /** The process that holds a `running` row. */
  readonly pid?: number | undefined;
}

export interface Ledger {
  readonly rows: readonly Row[];
}

export class LedgerError extends Error {
  constructor(path: string, problem: string) {
    super(`browser leg ledger ${path}: ${problem}`);
    this.name = "LedgerError";
  }
}

/** A `running` row older than this is a run that died. A whole run takes about six minutes. */
export const STALE_RUNNING_MS = 3 * 60 * 60 * 1000;

const DAY = /^\d{4}-\d{2}-\d{2}$/u;

export const LEDGER_ENV = "COLLIE_BROWSER_LEG_STATE_DIR";
export const ROOT_ENV = "COLLIE_BROWSER_LEG_DIR";
export const REPO_URL = "https://github.com/AltanS/collie.git";

export const defaultStateDir = (home: string = homedir()): string => join(home, ".local", "state", "collie-browser-leg");
export const defaultRoot = (home: string = homedir()): string => join(home, ".cache", "collie-lab", "browser-leg-nightly");

export const sameTuple = (a: Tuple, b: Tuple): boolean => a.sha === b.sha && a.claude === b.claude && a.pi === b.pi && a.omp === b.omp && a.hc === b.hc;

export const tupleText = (t: Tuple): string => `collie main ${t.sha.slice(0, 7)}, claude ${t.claude}, pi ${t.pi}, omp ${t.omp}, hc ${t.hc}`;

export const emptyCounts = (): Counts => ({ pass: 0, fail: 0, "not reached": 0, "n/a": 0 });

function parseCounts(value: JsonValue | undefined): Counts | undefined {
  const node = asJsonObject(value);
  if (node === undefined) return undefined;
  const out = emptyCounts();
  for (const verdict of VERDICTS) {
    const n = asJsonNumber(node[verdict]);
    if (n === undefined) return undefined;
    out[verdict] = n;
  }
  return out;
}

function parseVerdicts(value: JsonValue | undefined): Verdicts | undefined {
  const node = asJsonObject(value);
  if (node === undefined) return undefined;
  const claude = parseCounts(node.claude);
  const pi = parseCounts(node.pi);
  const omp = parseCounts(node.omp);
  return claude === undefined || pi === undefined || omp === undefined ? undefined : { claude, pi, omp };
}

function parseRow(path: string, value: JsonValue | undefined, index: number): Row {
  const at = `rows[${String(index)}]`;
  const node = asJsonObject(value);
  if (node === undefined) throw new LedgerError(path, `${at} is not an object`);
  const text = (name: string): string => {
    const got = asJsonString(node[name]);
    if (got === undefined || got === "") throw new LedgerError(path, `${at}.${name} is missing`);
    return got;
  };
  const date = text("date");
  if (!DAY.test(date)) throw new LedgerError(path, `${at}.date is not YYYY-MM-DD`);
  const result = RESULTS.find((word) => word === node.result);
  if (result === undefined) throw new LedgerError(path, `${at}.result is not one of ${RESULTS.join(", ")}`);
  return {
    sha: text("sha"),
    claude: text("claude"),
    pi: text("pi"),
    omp: text("omp"),
    hc: asJsonString(node.hc) ?? HC_NONE,
    date,
    result,
    log: text("log"),
    results: asJsonString(node.results),
    table: asJsonString(node.table),
    crewResults: asJsonString(node.crewResults),
    crewTable: asJsonString(node.crewTable),
    coreResults: asJsonString(node.coreResults),
    coreTable: asJsonString(node.coreTable),
    verdicts: parseVerdicts(node.verdicts),
    tiers: asJsonString(node.tiers),
    note: asJsonString(node.note),
    startedAt: asJsonNumber(node.startedAt),
    pid: asJsonNumber(node.pid),
  };
}

/**
 * The ledger at `path`. A missing file is an empty ledger. A file that is there and cannot be read is
 * an error, never an empty ledger: an empty one would run every tuple again, and each run costs.
 */
export function readLedger(path: string): Ledger {
  if (!existsSync(path)) return { rows: [] };
  const root = parseJson(readFileSync(path, "utf8"));
  if (root === undefined) throw new LedgerError(path, "not valid JSON");
  const rows = asJsonObject(root)?.rows;
  if (!Array.isArray(rows)) throw new LedgerError(path, 'expected { "rows": [ ... ] }');
  return { rows: rows.map((row, i) => parseRow(path, row, i)) };
}

function rowJson(row: Row): JsonObject {
  // The optional fields stay `undefined` when absent, and JSON.stringify leaves such a key out.
  return {
    sha: row.sha,
    claude: row.claude,
    pi: row.pi,
    omp: row.omp,
    hc: row.hc,
    date: row.date,
    result: row.result,
    log: row.log,
    results: row.results,
    table: row.table,
    crewResults: row.crewResults,
    crewTable: row.crewTable,
    coreResults: row.coreResults,
    coreTable: row.coreTable,
    verdicts: row.verdicts === undefined ? undefined : { claude: { ...row.verdicts.claude }, pi: { ...row.verdicts.pi }, omp: { ...row.verdicts.omp } },
    tiers: row.tiers,
    note: row.note,
    startedAt: row.startedAt,
    pid: row.pid,
  };
}

/** Writes through a temporary file and a rename, so a crash leaves the old ledger or the new one. */
export function writeLedger(path: string, ledger: Ledger): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ rows: ledger.rows.map(rowJson) }, null, 2)}\n`);
  renameSync(temp, path);
}

export type Alive = (pid: number) => boolean;

/** Whether a process with this pid exists. A pid we may not signal still exists. */
export const pidAlive: Alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

/** A `running` row is stale when its process is gone or it is older than {@link STALE_RUNNING_MS}. */
export function isStale(row: Row, now: number, alive: Alive): boolean {
  if (row.result !== "running") return false;
  if (now - (row.startedAt ?? 0) > STALE_RUNNING_MS) return true;
  return row.pid !== undefined && !alive(row.pid);
}

export interface Expired {
  readonly ledger: Ledger;
  readonly moved: number;
}

/** Stale `running` rows become `failed`. Nothing else changes. */
export function expireStale(ledger: Ledger, now: number, alive: Alive): Expired {
  let moved = 0;
  const rows = ledger.rows.map((row): Row => {
    if (!isStale(row, now, alive)) return row;
    moved++;
    const { startedAt, pid, ...kept } = row;
    void startedAt;
    void pid;
    return { ...kept, result: "failed", note: "interrupted: the run never wrote its end" };
  });
  return { ledger: { rows }, moved };
}

export type Plan =
  /** No row for this tuple, and no run is active: it would run. */
  | { readonly kind: "run" }
  /** This tuple has a row, in any result: it never runs again. */
  | { readonly kind: "skip"; readonly row: Row }
  /** Another tuple has a live `running` row: that run holds the clone and the rig. */
  | { readonly kind: "busy"; readonly row: Row };

/** The stop rule. Call it on a ledger whose stale rows were settled. */
export function planOf(ledger: Ledger, tuple: Tuple): Plan {
  const own = ledger.rows.find((row) => sameTuple(row, tuple));
  if (own !== undefined) return { kind: "skip", row: own };
  const active = ledger.rows.find((row) => row.result === "running");
  if (active !== undefined) return { kind: "busy", row: active };
  return { kind: "run" };
}

/** The ledger, with stale rows settled. Written back only when `write` is set and a row moved. */
export function loadLedger(path: string, now: number, alive: Alive, write: boolean): Ledger {
  const { ledger, moved } = expireStale(readLedger(path), now, alive);
  if (moved > 0 && write) writeLedger(path, ledger);
  return ledger;
}

/** A lock a crashed writer left behind is older than this. */
const STALE_LOCK_MS = 5 * 60 * 1000;

function takeLock(lock: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lock);
      return true;
    } catch {
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue;
      }
      if (age <= STALE_LOCK_MS) return false;
      rmSync(lock, { recursive: true, force: true });
    }
  }
  return false;
}

const nap = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Runs `fn` with the ledger's lock directory held, waiting a few seconds for it. False: never got it. */
function withLock<T>(path: string, fn: () => T): { readonly got: true; readonly value: T } | { readonly got: false } {
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  for (let i = 0; i < 50; i++) {
    if (takeLock(lock)) {
      try {
        return { got: true, value: fn() };
      } finally {
        rmdirSync(lock);
      }
    }
    nap(100);
  }
  return { got: false };
}

/** `claimed`: the `running` row is written. `taken`: the tuple has a row. `busy`: another run is active. */
export type Claim = "claimed" | "taken" | "busy";

/**
 * Take a tuple: write its `running` row. Nothing is written unless the answer is `claimed`, apart from
 * stale rows settling to `failed`. Call it before the first paid step.
 */
export function claim(path: string, tuple: Tuple, meta: { readonly date: string; readonly log: string; readonly now: number; readonly pid: number }, alive: Alive): Claim {
  const locked = withLock(path, (): Claim => {
    const { ledger, moved } = expireStale(readLedger(path), meta.now, alive);
    const plan = planOf(ledger, tuple);
    if (plan.kind === "run") {
      const row: Row = { ...tuple, date: meta.date, result: "running", log: meta.log, startedAt: meta.now, pid: meta.pid };
      writeLedger(path, { rows: [...ledger.rows, row] });
      return "claimed";
    }
    if (moved > 0) writeLedger(path, ledger);
    return plan.kind === "skip" ? "taken" : "busy";
  });
  return locked.got ? locked.value : "busy";
}

export interface Settlement {
  readonly result: Exclude<Result, "running">;
  readonly note: string;
  readonly results?: string | undefined;
  readonly table?: string | undefined;
  readonly crewResults?: string | undefined;
  readonly crewTable?: string | undefined;
  readonly coreResults?: string | undefined;
  readonly coreTable?: string | undefined;
  readonly verdicts?: Verdicts | undefined;
  readonly tiers?: string | undefined;
}

/** Finish a claimed tuple. Throws when the tuple has no `running` row: a result needs a claim. */
export function settle(path: string, tuple: Tuple, patch: Settlement): Row {
  const locked = withLock(path, (): Row => {
    const ledger = readLedger(path);
    const row = ledger.rows.find((candidate) => sameTuple(candidate, tuple));
    if (row === undefined || row.result !== "running") throw new LedgerError(path, `${tupleText(tuple)} has no running row to settle`);
    // A settled row has no start time and no pid: only a claim needs them.
    const { startedAt, pid, ...kept } = row;
    void startedAt;
    void pid;
    const next: Row = { ...kept, result: patch.result, note: patch.note, results: patch.results, table: patch.table, crewResults: patch.crewResults, crewTable: patch.crewTable, coreResults: patch.coreResults, coreTable: patch.coreTable, verdicts: patch.verdicts, tiers: patch.tiers };
    writeLedger(path, { rows: ledger.rows.map((candidate) => (candidate === row ? next : candidate)) });
    return next;
  });
  if (!locked.got) throw new LedgerError(path, "the ledger lock never came free");
  return locked.value;
}

// ── versions, blockers ───────────────────────────────────────────────────────────────────────────

/** The first x.y.z in a binary's `--version` output: `2.1.302 (Claude Code)`, `0.87.1`, `omp/18.6.1`. */
export function parseVersion(output: string): string | undefined {
  return /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/u.exec(output)?.[0];
}

/** The remote's main sha out of `git ls-remote <url> refs/heads/main`. */
export function parseRemoteSha(output: string): string | undefined {
  return /^([0-9a-f]{40})\s+refs\/heads\/main$/mu.exec(output)?.[1];
}

/** The login must last this long, so the run never meets its end (seed.ts MIN_MINUTES_LEFT). */
export const MIN_CLAUDE_MINUTES = 25;
/** The leg stops before a browser or a harness starts when less than this is free (rig-lib.ts). */
export const MIN_MEM_KB = 8 * 1024 * 1024;

/** The minutes left on the Claude access token, from the credentials file's text. Reads the expiry only. */
export function claudeMinutesLeft(credentials: string, now: number): number | undefined {
  const expiresAt = asJsonNumber(asJsonObject(asJsonObject(parseJson(credentials))?.claudeAiOauth)?.expiresAt);
  return expiresAt === undefined ? undefined : (expiresAt - now) / 60_000;
}

/** The model the leg starts Claude on: the leg keeps no COLLIE_RIG_CLAUDE_MODEL (KEPT_RIG_NAMES), so tier.ts modelFor's default. */
const LEG_CLAUDE_MODEL = "haiku";

/**
 * Whether Claude replays on both legs (M67 spec 07): the recordings' meta.json names a solo and a crew
 * leg on this model and this walky talky skill hash (tier.ts coverGap). A replay starts Claude on a
 * dummy login, so it needs no real one. Pure.
 */
export function claudeReplays(metaText: string | undefined, skill: string, model: string = LEG_CLAUDE_MODEL): boolean {
  if (metaText === undefined) return false;
  const legs = asJsonObject(asJsonObject(parseJson(metaText))?.legs);
  return ["solo", "crew"].every((leg) => {
    const meta = asJsonObject(legs?.[leg]);
    return asJsonString(meta?.model) === model && asJsonString(meta?.skill) === skill;
  });
}

/** What the machine says, before a run. `null`: could not be read. */
export interface Facts {
  readonly memKb: number | null;
  readonly bun: boolean;
  readonly herdr: boolean;
  readonly git: boolean;
  /** Whether COLLIE_RIG_KEY_FILE is set, and whether it names a readable file. */
  readonly keyFile: "unset" | "unusable" | "ok";
  readonly claudeMinutesLeft: number | null;
  /**
   * True when Claude replays on both legs, so the login check does not apply. Read from the
   * recordings of THIS checkout, the one the runner started from: main is cloned after the row is
   * written. When main has recorded a version since, this says false and keeps the check. When main
   * has changed the skill text since, this says true and main runs Claude live: the leg's own seed
   * check (seed.ts MIN_MINUTES_LEFT) then stops Claude at its start, never half way.
   */
  readonly claudeReplays: boolean;
}

/** The reasons a run cannot start. Empty: it can. Pure; the words are what `notify.log` gets. */
export function blockers(facts: Facts): string[] {
  const out: string[] = [];
  if (facts.keyFile === "unset") out.push("COLLIE_RIG_KEY_FILE is not set");
  else if (facts.keyFile === "unusable") out.push("COLLIE_RIG_KEY_FILE does not name a readable file");
  // A Claude replay starts on a dummy login, so the real one is checked only for a live Claude.
  if (!facts.claudeReplays) {
    if (facts.claudeMinutesLeft === null) out.push("no usable Claude login in ~/.claude/.credentials.json");
    else if (facts.claudeMinutesLeft < MIN_CLAUDE_MINUTES) out.push(`the Claude login has ${String(Math.max(0, Math.floor(facts.claudeMinutesLeft)))} min left, the leg needs ${String(MIN_CLAUDE_MINUTES)}`);
  }
  if (!facts.herdr) out.push("herdr is not on PATH");
  if (!facts.bun) out.push("bun is not on PATH");
  if (!facts.git) out.push("git is not on PATH");
  if (facts.memKb === null) out.push("cannot read the free memory");
  else if (facts.memKb < MIN_MEM_KB) out.push(`${(facts.memKb / 1024 / 1024).toFixed(1)} GB of memory free, the leg needs ${String(MIN_MEM_KB / 1024 / 1024)}`);
  return out;
}

// ── the leg's table ──────────────────────────────────────────────────────────────────────────────

export interface TableRow {
  readonly harness: HarnessId;
  readonly verdict: Verdict;
}

/**
 * The cells of table.md (global-teardown.ts): `| harness | scenario | verdict | taps | note |`. The note
 * may hold a pipe, so only the first three cells are read, and the verdict must be a known word.
 */
export function parseTable(text: string): TableRow[] {
  const out: TableRow[] = [];
  for (const line of text.split("\n")) {
    const cells = /^\|\s*(claude|pi|omp)\s*\|[^|]*\|\s*(pass|fail|not reached|n\/a)\s*\|/u.exec(line);
    const harness = HARNESS_IDS.find((id) => id === cells?.[1]);
    const verdict = VERDICTS.find((word) => word === cells?.[2]);
    if (harness !== undefined && verdict !== undefined) out.push({ harness, verdict });
  }
  return out;
}

export function countVerdicts(rows: readonly TableRow[]) {
  const out = { claude: emptyCounts(), pi: emptyCounts(), omp: emptyCounts() } satisfies Verdicts;
  for (const row of rows) out[row.harness][row.verdict]++;
  return out;
}

/** `5 pass`, or `3 pass, 1 fail, 1 not reached`. */
export function countsText(counts: Counts): string {
  const parts = VERDICTS.filter((verdict) => counts[verdict] > 0).map((verdict) => `${String(counts[verdict])} ${verdict}`);
  return parts.length === 0 ? "no cases" : parts.join(", ");
}

export interface Decision {
  readonly result: Exclude<Result, "running">;
  readonly note: string;
  readonly verdicts?: Verdicts | undefined;
}

/**
 * One leg's result from its table and exit code. `harnesses` are the ones the leg has cases for: all
 * three for the solo leg, only Claude for the crew leg (cases 12 to 15 and 19 to 21 run under Claude).
 *  - no table, or a harness without a case: `failed`, nothing was proven;
 *  - any `fail`: `fail`;
 *  - no `fail`, but a case `not reached` or `n/a`: `failed`, the case proved nothing;
 *  - every case `pass` and exit 0: `pass`.
 */
export function decide(table: readonly TableRow[] | null, exitCode: number | null, harnesses: readonly HarnessId[] = HARNESS_IDS): Decision {
  if (table === null || table.length === 0) return { result: "failed", note: `the leg wrote no table (exit ${String(exitCode)})` };
  const verdicts = countVerdicts(table);
  const total = (id: HarnessId): number => VERDICTS.reduce((sum, verdict) => sum + verdicts[id][verdict], 0);
  const empty = harnesses.filter((id) => total(id) === 0);
  if (empty.length > 0) return { result: "failed", note: `no case for ${empty.join(", ")} in the table`, verdicts };
  const sum = (verdict: Verdict): number => HARNESS_IDS.reduce((all, id) => all + verdicts[id][verdict], 0);
  const where = (verdict: Verdict): string =>
    HARNESS_IDS.filter((id) => verdicts[id][verdict] > 0)
      .map((id) => `${id} ${String(verdicts[id][verdict])}`)
      .join(", ");
  if (sum("fail") > 0) return { result: "fail", note: `${String(sum("fail"))} case(s) failed: ${where("fail")}`, verdicts };
  const missing = (["not reached", "n/a"] as const).filter((verdict) => sum(verdict) > 0);
  if (missing.length > 0) return { result: "failed", note: `${String(missing.reduce((all, verdict) => all + sum(verdict), 0))} case(s) proved nothing: ${missing.map((verdict) => `${verdict} ${where(verdict)}`).join("; ")}`, verdicts };
  if (exitCode !== 0) return { result: "failed", note: `every case passed, but the leg exited ${String(exitCode)}`, verdicts };
  return { result: "pass", note: `${String(sum("pass"))} cases passed`, verdicts };
}

/** Whether the crew leg runs: the solo leg started, which it shows by writing a table with cases in it. */
export function crewLegRuns(soloTable: readonly TableRow[] | null): boolean {
  return soloTable !== null && soloTable.length > 0;
}

/** The two legs' counts added up per harness. */
export function addVerdicts(a: Verdicts | undefined, b: Verdicts | undefined): Verdicts | undefined {
  if (a === undefined || b === undefined) return a ?? b;
  const out = { claude: emptyCounts(), pi: emptyCounts(), omp: emptyCounts() } satisfies Verdicts;
  for (const id of HARNESS_IDS) for (const verdict of VERDICTS) out[id][verdict] = a[id][verdict] + b[id][verdict];
  return out;
}

const passes = (verdicts: Verdicts | undefined): number => (verdicts === undefined ? 0 : HARNESS_IDS.reduce((all, id) => all + verdicts[id].pass, 0));

/**
 * The row's result from all three legs. `crew` and `core` are null when that leg did not run.
 *  - any leg with a `fail`: `fail`;
 *  - else any leg `failed` (no table, not reached, n/a, a bad exit), or a leg that did not run: `failed`;
 *  - else `pass`: every leg passed every case.
 * The core leg counts like the others: a `fail` or `failed` from it holds the row.
 * The note names each leg that did not pass (`solo leg: ...; crew leg: ...; core leg: ...`), so the
 * notify line says which leg to look at. The counts are the legs' added up.
 */
export function decideLegs(solo: Decision, crew: Decision | null, core: Decision | null): Decision {
  const verdicts = addVerdicts(addVerdicts(solo.verdicts, crew?.verdicts), core?.verdicts);
  const legs: ReadonlyArray<readonly [string, Decision | null]> = [
    ["solo", solo],
    ["crew", crew],
    ["core", core],
  ];
  const bad = legs.filter(([, decision]) => decision === null || decision.result !== "pass");
  if (bad.length === 0) return { result: "pass", note: `${String(passes(verdicts))} cases passed (solo ${String(passes(solo.verdicts))}, crew ${String(passes(crew?.verdicts))}, core ${String(passes(core?.verdicts))})`, verdicts };
  const note = bad.map(([label, decision]) => `${label} leg: ${decision === null ? "not run" : decision.note}`).join("; ");
  const result = legs.some(([, decision]) => decision?.result === "fail") ? "fail" : "failed";
  return { result, note, verdicts };
}

export const exitCodeOf = (result: Exclude<Result, "running">): number => (result === "pass" ? 0 : result === "fail" ? 1 : 2);

// ── the command line ─────────────────────────────────────────────────────────────────────────────

export interface Options {
  readonly plan: boolean;
  readonly stateDir: string;
  readonly root: string;
  readonly repo: string;
}

export const USAGE = `Usage: bun web/e2e/rig/nightly.ts [options]

Runs the browser leg (the solo leg, the crew leg, then the solo leg again on herdr-core) on origin/main once per tuple: (collie main sha,
Claude Code version, pi version, omp version, hc version). A tuple with a row in the ledger never runs again, whatever the result. A person reruns
a tuple by deleting its row. The runner never deletes one.

  --plan             print the tuple and whether it would run, and any blocker. Spends nothing, writes nothing
  --state-dir DIR    ledger.json and notify.log (default ~/.local/state/collie-browser-leg, or $${LEDGER_ENV})
  --root DIR         the runner's clone, rig states (state, crew-state, core-state) and logs (default ~/.cache/collie-lab/browser-leg-nightly,
                     or $${ROOT_ENV}). A run needs it under ~/.cache/collie-lab
  --repo URL         the repository to clone and read main from (default ${REPO_URL})
  -h, --help         print this

Environment: COLLIE_RIG_KEY_FILE names the dotenv file with the provider key (the runner never reads it).
Exit: 0 pass or nothing to do, 1 a case failed, 2 the run could not finish.`;

export function parseOptions(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, home: string = homedir()): Options | "help" {
  let plan = false;
  let stateDir = resolve(env[LEDGER_ENV] !== undefined && env[LEDGER_ENV] !== "" ? env[LEDGER_ENV] : defaultStateDir(home));
  let root = resolve(env[ROOT_ENV] !== undefined && env[ROOT_ENV] !== "" ? env[ROOT_ENV] : defaultRoot(home));
  let repo = REPO_URL;
  const value = (i: number, flag: string): string => {
    const got = argv[i + 1];
    if (got === undefined || got.startsWith("--")) throw new Error(`${flag} needs a value`);
    return got;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        return "help";
      case "--plan":
        plan = true;
        break;
      case "--state-dir":
        stateDir = resolve(value(i, arg));
        i++;
        break;
      case "--root":
        root = resolve(value(i, arg));
        i++;
        break;
      case "--repo":
        repo = value(i, arg);
        i++;
        break;
      default:
        throw new Error(`unknown option "${String(arg)}"`);
    }
  }
  return { plan, stateDir, root, repo };
}

// ── the run: what main() asks of the world ───────────────────────────────────────────────────────

export interface Outcome {
  readonly result: Exclude<Result, "running">;
  readonly note: string;
  readonly results?: string | undefined;
  readonly table?: string | undefined;
  readonly crewResults?: string | undefined;
  readonly crewTable?: string | undefined;
  readonly coreResults?: string | undefined;
  readonly coreTable?: string | undefined;
  readonly verdicts?: Verdicts | undefined;
  readonly tiers?: string | undefined;
}

export interface RunContext {
  readonly tuple: Tuple;
  readonly options: Options;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: string;
}

/** Everything main() touches outside its own arguments, so the tests can stand in for it. */
export interface World {
  now(): number;
  /** Throws with a reason when the remote cannot be read. */
  remoteSha(repo: string): string;
  /** Throws with a reason when the binary cannot be run. */
  version(id: VersionId): string;
  facts(env: Readonly<Record<string, string | undefined>>): Facts;
  alive: Alive;
  pid: number;
  /** The clone, the build, the leg. May throw: main() settles the row `failed`. */
  execute(context: RunContext): Promise<Outcome>;
}

export interface Out {
  line(text: string): void;
  error(text: string): void;
}

const consoleOut: Out = { line: (text) => console.log(text), error: (text) => console.error(text) };

function notify(options: Options, out: Out, now: number, line: string): void {
  mkdirSync(options.stateDir, { recursive: true });
  appendFileSync(join(options.stateDir, "notify.log"), `${new Date(now).toISOString()} ${line}\n`);
  out.line(`NOTIFY ${line}`);
}

/** What `--plan` says about the second leg. The crew leg needs nothing the solo leg does not. */
export const PLAN_CREW = "plan: includes the crew leg after the solo leg (its own rig state, about 1 more minute, 4 Claude turns and 2 pi turns when they run live)";

/** What `--plan` says about the third leg: the solo leg again, on herdr-core. It has a rig state of its own and the same model rules. */
export const PLAN_CORE = "plan: includes the core solo leg after the crew leg (herdr-core, its own rig state, about 30 more minutes; the same turns as the solo leg when a harness version is new, none on replay)";

/** The summary: one line per harness (all legs' counts), then the solo table's path, then the crew table's, then the core table's. */
export function summaryLines(tuple: Tuple, outcome: Outcome): string[] {
  const lines = HARNESS_IDS.map((id) => `${id} ${tuple[id]}: ${outcome.verdicts === undefined ? "no verdict" : countsText(outcome.verdicts[id])}`);
  lines.push(outcome.table === undefined ? `table: none (${outcome.note})` : `table: ${outcome.table} (collie main ${tuple.sha.slice(0, 7)}, ${outcome.result})`);
  if (outcome.crewTable !== undefined) lines.push(`crew table: ${outcome.crewTable}`);
  if (outcome.coreTable !== undefined) lines.push(`core table: ${outcome.coreTable}`);
  if (outcome.tiers !== undefined) lines.push(`model tiers: ${outcome.tiers}`);
  return lines;
}

/**
 * One invocation. Returns the exit code.
 *
 * The order is the cost order. The tuple and the ledger come first and cost nothing, so a tuple that
 * already has a row ends the run before anything else is checked or written. Then the blockers, which
 * write no row. Then the claim, which writes the `running` row. Then the run.
 */
export async function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, world: World, out: Out = consoleOut): Promise<number> {
  let options: Options | "help";
  try {
    options = parseOptions(argv, env);
  } catch (error) {
    out.error(`browser leg nightly: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  if (options === "help") {
    out.line(USAGE);
    return 0;
  }
  const opts = options;
  const now = world.now();
  const ledgerFile = join(opts.stateDir, "ledger.json");
  /** A cannot-start: costs nothing, writes no row. `--plan` only says it. */
  const cannot = (why: string): number => {
    if (opts.plan) out.line(`plan: cannot run: ${why}`);
    else notify(opts, out, now, `browser leg: cannot start: ${why}`);
    return 2;
  };

  let tuple: Tuple;
  try {
    const sha = world.remoteSha(opts.repo);
    tuple = { sha, claude: world.version("claude"), pi: world.version("pi"), omp: world.version("omp"), hc: world.version("hc") };
  } catch (error) {
    return cannot(error instanceof Error ? error.message : String(error));
  }

  let ledger: Ledger;
  try {
    ledger = loadLedger(ledgerFile, now, world.alive, !opts.plan);
  } catch (error) {
    return cannot(error instanceof Error ? error.message : String(error));
  }
  const plan = planOf(ledger, tuple);
  if (opts.plan) out.line(`plan: ${tupleText(tuple)}`);
  if (plan.kind === "skip") {
    out.line(`${opts.plan ? "plan: would not run" : "nothing to do"}: the ledger has a row for this tuple (${plan.row.result}, ${plan.row.date}). Delete the row to run it again`);
    return 0;
  }
  if (plan.kind === "busy") {
    out.line(`${opts.plan ? "plan: would not run" : "nothing to do"}: another run holds the line (${tupleText(plan.row)}, pid ${String(plan.row.pid)})`);
    return 0;
  }

  const problems = blockers(world.facts(env));
  if (opts.plan) {
    out.line(problems.length === 0 ? "plan: would run" : "plan: would not start");
    out.line(PLAN_CREW);
    out.line(PLAN_CORE);
    for (const problem of problems) out.line(`plan: blocked: ${problem}`);
    return 0;
  }
  if (problems.length > 0) return cannot(problems.join("; "));

  const stamp = new Date(now).toISOString().replace(/[:.]/gu, "-");
  const log = join(opts.root, "logs", `${stamp}-${tuple.sha.slice(0, 7)}.log`);
  let taken: Claim;
  try {
    taken = claim(ledgerFile, tuple, { date: new Date(now).toISOString().slice(0, 10), log, now, pid: world.pid }, world.alive);
  } catch (error) {
    return cannot(error instanceof Error ? error.message : String(error));
  }
  if (taken !== "claimed") {
    out.line(`nothing to do: ${taken === "taken" ? "another run took this tuple" : "another run holds the line"}`);
    return 0;
  }

  let outcome: Outcome;
  try {
    outcome = await world.execute({ tuple, options: opts, env, log });
  } catch (error) {
    outcome = { result: "failed", note: error instanceof Error ? error.message : String(error) };
  }
  try {
    settle(ledgerFile, tuple, outcome);
  } catch (error) {
    // The row stays `running`; the next start settles it to `failed`. Say so, and say what the run found.
    out.error(`browser leg nightly: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const line of summaryLines(tuple, outcome)) out.line(line);
  if (outcome.result !== "pass") notify(opts, out, world.now(), `browser leg: ${tupleText(tuple)} ${outcome.result}: ${outcome.note} (log ${log}${outcome.table === undefined ? "" : `, table ${outcome.table}`}${outcome.crewTable === undefined ? "" : `, crew table ${outcome.crewTable}`}${outcome.coreTable === undefined ? "" : `, core table ${outcome.coreTable}`})`);
  return exitCodeOf(outcome.result);
}

// ── the real world ───────────────────────────────────────────────────────────────────────────────

const HERE_ROOT = resolve(import.meta.dirname, "..", "..", "..");

function which(name: string, path: string | undefined): boolean {
  return (path ?? "").split(delimiter).some((dir) => {
    if (dir === "") return false;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function memAvailableKb(): number | null {
  try {
    const line = readFileSync("/proc/meminfo", "utf8")
      .split("\n")
      .find((row) => row.startsWith("MemAvailable:"));
    const kb = Number(/(\d+)/u.exec(line ?? "")?.[1]);
    return Number.isFinite(kb) ? kb : null;
  } catch {
    return null;
  }
}

function keyFileState(path: string | undefined): Facts["keyFile"] {
  if (path === undefined || path === "") return "unset";
  try {
    accessSync(path, constants.R_OK);
    return isAbsolute(path) && statSync(path).isFile() ? "ok" : "unusable";
  } catch {
    return "unusable";
  }
}

function realFacts(env: Readonly<Record<string, string | undefined>>, now: number): Facts {
  let minutes: number | null = null;
  try {
    minutes = claudeMinutesLeft(readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf8"), now) ?? null;
  } catch {
    minutes = null;
  }
  return {
    memKb: memAvailableKb(),
    bun: which("bun", env.PATH),
    herdr: which("herdr", env.PATH),
    git: which("git", env.PATH),
    keyFile: keyFileState(env.COLLIE_RIG_KEY_FILE),
    claudeMinutesLeft: minutes,
    claudeReplays: recordedHere(),
  };
}

/** claudeReplays for the Claude version on PATH, against this checkout's recordings and skill text. */
function recordedHere(): boolean {
  try {
    const version = versionOf("claude");
    if (!/^[0-9A-Za-z.+-]+$/u.test(version)) return false;
    const meta = join(HERE_ROOT, "web", "e2e", "rig", "cassettes", "claude", version, "meta.json");
    const skill = createHash("sha256").update(readFileSync(join(HERE_ROOT, "cli", "skills", "walky-talky.md"), "utf8")).digest("hex").slice(0, 16);
    return claudeReplays(existsSync(meta) ? readFileSync(meta, "utf8") : undefined, skill);
  } catch {
    return false;
  }
}

function remoteShaOf(repo: string): string {
  const r = spawnSync("git", ["ls-remote", repo, "refs/heads/main"], { encoding: "utf8", timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const sha = r.status === 0 ? parseRemoteSha(r.stdout) : undefined;
  if (sha === undefined) throw new Error(`cannot read main of ${repo} (git ls-remote exit ${String(r.status)}: ${(r.stderr ?? "").trim().slice(0, 200)})`);
  return sha;
}

/** The program a version is read from: the harness binaries bins.ts names, and `hc` from PATH. */
const binaryOf = (id: VersionId): string => (id === "hc" ? "hc" : BIN[id]);

function versionOf(id: VersionId): string {
  const r = spawnSync(binaryOf(id), ["--version"], { encoding: "utf8", timeout: 30_000 });
  const version = r.status === 0 ? parseVersion(`${r.stdout}${r.stderr}`) : undefined;
  if (version === undefined) throw new Error(`cannot read the ${id} version from ${binaryOf(id)} --version (exit ${String(r.status)})`);
  return version;
}

/** The names of COLLIE_RIG_* the leg keeps from this process's environment. */
const KEPT_RIG_NAMES = new Set(["COLLIE_RIG_KEY_FILE", "COLLIE_RIG_CLAUDE_BIN", "COLLIE_RIG_PI_BIN", "COLLIE_RIG_OMP_BIN", "COLLIE_RIG_PI_MODEL", "COLLIE_RIG_OMP_MODEL"]);

/**
 * The environment of the clone's steps. The leg's development knobs (KEEP, REUSE, a pane to take, a
 * harness turned off) are dropped so a shell of a person cannot turn a nightly run into half a run, and
 * the rig gets a state root of its own, so a leg a person runs by hand is never taken down by this one.
 */
export function legEnv(base: Readonly<Record<string, string | undefined>>, stateRoot: string) {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (name.startsWith("COLLIE_RIG_") && !KEPT_RIG_NAMES.has(name)) continue;
    out[name] = value;
  }
  out.COLLIE_RIG_STATE = stateRoot;
  return out;
}

/**
 * The run id and folder a leg's teardown prints: `Browser leg, run <id> (results in <dir>):` for the
 * solo leg, `Browser leg (crew), run <id> (results in <dir>):` for the crew leg (global-teardown.ts).
 */
export function resultsFolderIn(logText: string, leg: "solo" | "crew" = "solo"): string | undefined {
  const pattern = leg === "crew" ? /^Browser leg \(crew\), run \S+ \(results in (.+)\):$/gmu : /^Browser leg, run \S+ \(results in (.+)\):$/gmu;
  return [...logText.matchAll(pattern)].at(-1)?.[1];
}

/** The crew leg's rig state, beside the solo leg's (`<root>/state`). */
export const crewStateRoot = (root: string): string => join(root, "crew-state");

/** The core solo leg's rig state, beside the other two. */
export const coreStateRoot = (root: string): string => join(root, "core-state");

/** The multiplexer the core leg's rig runs (rig-mux.ts), set on the leg's environment after the operator's own COLLIE_RIG_MUX was dropped. */
export const CORE_MUX = "herdr-core";

const MINUTE = 60_000;
let activeChild: ChildProcess | null = null;
let interrupted = false;

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* gone */
  }
}

/** A signal stops the step that runs, and the run then settles its row `failed`. */
function onSignals(): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      interrupted = true;
      if (activeChild !== null) killGroup(activeChild, "SIGTERM");
    });
  }
}

/** One step of the run, its output appended to the log. Resolves to the exit code; null: killed. */
function step(logFd: number, label: string, command: string, args: readonly string[], cwd: string, env: Record<string, string>, timeoutMs: number): Promise<number | null> {
  if (interrupted) return Promise.reject(new Error("interrupted by a signal"));
  writeSync(logFd, `\n== ${new Date().toISOString()} ${label}: ${command} ${args.join(" ")}\n`);
  return new Promise((done, fail) => {
    const child = spawn(command, [...args], { cwd, env, stdio: ["ignore", logFd, logFd], detached: true });
    activeChild = child;
    const timer = setTimeout(() => {
      writeSync(logFd, `\n== ${label} timed out after ${String(timeoutMs / MINUTE)} min\n`);
      killGroup(child, "SIGTERM");
      setTimeout(() => killGroup(child, "SIGKILL"), 10_000).unref();
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      activeChild = null;
      fail(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      activeChild = null;
      done(code);
    });
  });
}

async function mustStep(logFd: number, label: string, command: string, args: readonly string[], cwd: string, env: Record<string, string>, timeoutMs: number): Promise<void> {
  const code = await step(logFd, label, command, args, cwd, env, timeoutMs);
  if (code !== 0) throw new Error(`${label} exited ${String(code)}${interrupted ? " (interrupted by a signal)" : ""}`);
}

/** The run folders in the rig state, oldest first. */
function runFolders(stateRoot: string): string[] {
  const base = join(stateRoot, "results");
  return existsSync(base) ? readdirSync(base).toSorted().map((name) => join(base, name)) : [];
}

interface LegRun {
  readonly folder: string | undefined;
  /** The leg's table.md, when the leg wrote one. */
  readonly table: string | undefined;
  readonly rows: TableRow[] | null;
  readonly decision: Decision;
  /** `pi replay, omp live+record`, from the leg's model.json, or undefined when it wrote none. */
  readonly tiers: string | undefined;
}

/**
 * The tiers a leg's teardown wrote into `<folder>/model.json` (global-teardown.ts), as words:
 * `pi replay, omp live+record`. Undefined for a folder without one (a leg that never got that far).
 */
export function tiersOf(folder: string | undefined): string | undefined {
  if (folder === undefined) return undefined;
  const file = join(folder, "model.json");
  if (!existsSync(file)) return undefined;
  const tiers = asJsonObject(asJsonObject(parseJson(readFileSync(file, "utf8")))?.tiers);
  if (tiers === undefined) return undefined;
  const words = ["pi", "omp", "claude"].flatMap((h) => {
    const plan = asJsonObject(tiers[h]);
    const tier = asJsonString(plan?.tier);
    return tier === undefined ? [] : [`${h} ${tier}${plan?.record === true ? "+record" : ""}`];
  });
  return words.length === 0 ? undefined : words.join(", ");
}

/** Both legs' tiers in one ledger field. */
export function legTiers(solo: string | undefined, crew: string | undefined, core?: string | undefined): string | undefined {
  const parts = [solo === undefined ? null : `solo: ${solo}`, crew === undefined ? null : `crew: ${crew}`, core === undefined ? null : `core: ${core}`].filter((p): p is string => p !== null);
  return parts.length === 0 ? undefined : parts.join("; ");
}

/**
 * One leg: its Playwright run, then `rig.ts down` for the rig it may have left, then its table. The
 * crew leg's config and `down --crew` pick the crew rig; the state root and the environment are the
 * caller's. A leg that exits badly is a result, not a throw. Only a signal throws.
 */
async function runLeg(logFd: number, logPath: string, leg: "solo" | "crew" | "core", config: string, stateRoot: string, web: string, env: Record<string, string>, timeoutMs: number): Promise<LegRun> {
  // A folder that was there before the leg started is an earlier run's, never this run's.
  const before = new Set(runFolders(stateRoot));
  let code: number | null = null;
  try {
    code = await step(logFd, leg === "solo" ? "the leg" : leg === "crew" ? "the crew leg" : "the core leg", "bun", ["x", "playwright", "test", "-c", `e2e/rig/${config}`], web, env, timeoutMs);
  } finally {
    // The leg's teardown stops the rig. This stops what a crashed or killed leg left, by recorded pid.
    writeSync(logFd, `\n== ${new Date().toISOString()} rig down${leg === "crew" ? " --crew" : ""}\n`);
    spawnSync("bun", ["e2e/rig/rig.ts", "down", ...(leg === "crew" ? ["--crew"] : [])], { cwd: web, env, stdio: ["ignore", logFd, logFd], timeout: MINUTE });
  }
  if (interrupted) throw new Error("interrupted by a signal");
  // The core leg prints the solo leg's teardown line (the same config), so a line outside its own state is the solo leg's, never its own.
  const logged = resultsFolderIn(readFileSync(logPath, "utf8"), leg === "crew" ? "crew" : "solo");
  const own = logged !== undefined && (leg !== "core" || resolve(logged).startsWith(`${resolve(stateRoot)}${sep}`)) ? logged : undefined;
  const folder = own ?? runFolders(stateRoot).findLast((dir) => !before.has(dir));
  const tablePath = folder === undefined ? undefined : join(folder, "table.md");
  const table = tablePath !== undefined && existsSync(tablePath) ? tablePath : undefined;
  const rows = table !== undefined ? parseTable(readFileSync(table, "utf8")) : null;
  return { folder, table, rows, decision: decide(rows, code, leg === "crew" ? ["claude"] : HARNESS_IDS), tiers: tiersOf(folder) };
}

/** The clone, the build, the legs, the tables. Throws on any step that breaks. */
async function executeReal(context: RunContext): Promise<Outcome> {
  const { tuple, options } = context;
  const clone = join(options.root, "clone");
  const stateRoot = join(options.root, "state");
  const cacheLab = join(homedir(), ".cache", "collie-lab") + sep;
  if (!`${resolve(stateRoot)}${sep}`.startsWith(cacheLab)) throw new Error(`--root must be under ${cacheLab}: the rig keeps its state there`);
  mkdirSync(dirname(context.log), { recursive: true });
  const logFd = openSync(context.log, "a");
  const env = legEnv(context.env, stateRoot);
  const web = join(clone, "web");
  try {
    if (existsSync(join(clone, ".git"))) {
      if (realpathSync(clone) === realpathSync(HERE_ROOT)) throw new Error("the clone is the checkout this runner started from: refusing");
      await mustStep(logFd, "git remote", "git", ["remote", "set-url", "origin", options.repo], clone, env, 2 * MINUTE);
    } else {
      mkdirSync(options.root, { recursive: true });
      await mustStep(logFd, "git clone", "git", ["clone", "--quiet", options.repo, clone], options.root, env, 15 * MINUTE);
    }
    await mustStep(logFd, "git fetch", "git", ["fetch", "--quiet", "--prune", "origin"], clone, env, 10 * MINUTE);
    await mustStep(logFd, "git checkout", "git", ["checkout", "--quiet", "--force", "--detach", tuple.sha], clone, env, 2 * MINUTE);
    await mustStep(logFd, "git clean", "git", ["clean", "--quiet", "-fdx"], clone, env, 2 * MINUTE);
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: clone, encoding: "utf8" }).stdout.trim();
    if (head !== tuple.sha) throw new Error(`the clone is at ${head.slice(0, 7)}, not ${tuple.sha.slice(0, 7)}`);
    await mustStep(logFd, "bun install (root)", "bun", ["install", "--frozen-lockfile"], clone, env, 15 * MINUTE);
    await mustStep(logFd, "bun install (web)", "bun", ["install", "--frozen-lockfile"], web, env, 15 * MINUTE);
    await mustStep(logFd, "web build", "bun", ["run", "build"], web, env, 15 * MINUTE);
    await mustStep(logFd, "playwright browser", "bun", ["x", "playwright", "install", "chromium"], web, env, 15 * MINUTE);
    // The solo leg, the crew leg, then the core solo leg, each with a rig state of its own
    // (COLLIE_RIG_STATE, the name rig-lib.ts reads). Each rig is down before the next one comes up, and
    // they share nothing.
    const solo = await runLeg(logFd, context.log, "solo", "playwright.config.ts", stateRoot, web, env, 45 * MINUTE);
    if (!crewLegRuns(solo.rows)) {
      writeSync(logFd, `\n== ${new Date().toISOString()} the solo leg wrote no table: the crew leg and the core leg are not run\n`);
      return { ...decideLegs(solo.decision, null, null), results: solo.folder, table: solo.table, tiers: legTiers(solo.tiers, undefined) };
    }
    const crewState = crewStateRoot(options.root);
    if (!`${resolve(crewState)}${sep}`.startsWith(cacheLab)) throw new Error(`--root must be under ${cacheLab}: the rig keeps its state there`);
    const crew = await runLeg(logFd, context.log, "crew", "crew.config.ts", crewState, web, legEnv(context.env, crewState), 30 * MINUTE);
    const coreState = coreStateRoot(options.root);
    if (!`${resolve(coreState)}${sep}`.startsWith(cacheLab)) throw new Error(`--root must be under ${cacheLab}: the rig keeps its state there`);
    const core = await runLeg(logFd, context.log, "core", "playwright.config.ts", coreState, web, { ...legEnv(context.env, coreState), COLLIE_RIG_MUX: CORE_MUX }, 60 * MINUTE);
    return { ...decideLegs(solo.decision, crew.decision, core.decision), results: solo.folder, table: solo.table, crewResults: crew.folder, crewTable: crew.table, coreResults: core.folder, coreTable: core.table, tiers: legTiers(solo.tiers, crew.tiers, core.tiers) };
  } finally {
    closeSync(logFd);
  }
}

export const realWorld: World = {
  now: () => Date.now(),
  remoteSha: remoteShaOf,
  version: versionOf,
  facts: (env) => realFacts(env, Date.now()),
  alive: pidAlive,
  pid: process.pid,
  execute: executeReal,
};

if (import.meta.main) {
  onSignals();
  process.exitCode = await main(process.argv.slice(2), process.env, realWorld);
}
