// A day of load per machine, one bucket per minute, kept on the lead (or on a solo collie).
//
// ── WHY THE LEAD KEEPS IT, AND NOT EACH MEMBER ───────────────────────────────
// The phone talks to the lead, and the lead already hears every member's last sample on the sweep it
// runs anyway (CREW_PROTOCOL.md §10.1). Keeping the day there costs no new route on the crew link and
// no dial the phone can trigger. The price is named in ADR 0084: a member's history has gaps for the
// minutes the lead was down or the member was unreachable, and nothing back-fills them.
//
// ── IN MEMORY, SAVED FROM THE TICK ───────────────────────────────────────────
// `record` and `points` touch memory only. The owner (`bridge/machines.ts`) saves the whole store to
// `machine-history.json` at most every five minutes and on shutdown, from the engine tick, never from
// a timer of its own. A crash loses at most five minutes, which is the trade for not writing a file
// every few seconds. The file is atomic (`tmp` then `rename`) and owner-only (mode 0600, inside a
// state folder that is itself owner-only on every platform, ACL-locked on Windows).
//
// ── ONE RING OF TYPED ARRAYS PER MACHINE ─────────────────────────────────────
// A minute is seven numbers, and a day is 1440 minutes. Kept as one object per minute, a machine's
// day held about 175 KiB of heap (measured 2026-10-05 under Bun 1.4.1). Kept here as a ring of typed
// arrays, allocated once at the first sample, it is 1440 x 38 bytes, about 54 KiB, and it never
// grows. Each minute keeps running AVERAGES and their counts rather than sums: an average is what
// every reader wants, and the next sample folds in with `avg += (x - avg) / n`. CPU and memory stay
// 64-bit, because the alert evaluator compares them with the rule's line and a 32-bit 0.9 is below
// 0.9. The CPU maximum and the network rates are 32-bit: they are only ever drawn.
//
// ── THE FILE IS COMPACT ──────────────────────────────────────────────────────
// Version 2 stores, per machine, the first minute's start and one row per minute,
// `[gap, cpu, cpuMax, mem, rx, tx]`, where `gap` is the minutes since the row before (1 for a whole
// run) and the fractions are rounded to three places. Only the last row's sample count is kept, as
// `n`: it is the one minute a sample may still fold into. One machine's full day is about 52 KiB,
// where version 1 (nine sums per minute, epoch milliseconds on every row) was about 80 KiB, and the
// file is rewritten every five minutes. Version 1 still loads.

import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "./json.ts";
import { coerceHistoryFile } from "./machine-parse.ts";
import type { MachineHistoryPoint, MachineSample, MachineSpark } from "./types.ts";

export const MINUTE_MS = 60_000;
/** One day of minutes. A bucket older than this is dropped, on every read and every save. */
export const HISTORY_MINUTES = 1440;
const DAY_MS = HISTORY_MINUTES * MINUTE_MS;

/**
 * How far past the current minute a bucket may start before it is dropped as written by a clock that
 * has since stepped back. One minute: the open minute itself, and the next, for a clock that moved a
 * few seconds between two reads.
 */
export const FUTURE_SLACK_MS = MINUTE_MS;

/** The file in the state folder. Named here so `solo-baseline.test.ts`'s scan can read it. */
export const MACHINE_HISTORY_FILE = "machine-history.json";

/** The most minutes a spark may ask for (`GET /api/machines?spark=N`). */
export const SPARK_MAX_MINUTES = 60;

/**
 * One minute of one machine as the file hands it back: averages and the sample count behind them.
 * `rx` and `tx` are `null` for a minute with no network reading.
 */
export interface LoadedMinute {
  /** The minute's start, epoch ms. */
  readonly t: number;
  readonly n: number;
  readonly cpu: number;
  readonly cpuMax: number;
  readonly mem: number;
  readonly rx: number | null;
  readonly tx: number | null;
}

/** One complete minute as the alert evaluator reads it: the CPU average and the memory fraction. */
export interface MinuteReading {
  readonly t: number;
  readonly cpu: number;
  readonly mem: number;
}

/**
 * `machine-history.json`, version 2: per machine the first row's minute start (`t`), the sample
 * count of the LAST row (`n`), and one row per minute, `[gap, cpu, cpuMax, mem, rx | null, tx | null]`.
 * Read back by `coerceHistoryFile`, which also reads version 1.
 */
export interface MachineHistoryFile {
  version: 2;
  machines: Record<string, { t: number; n: number; rows: (number | null)[][] }>;
}

/** The start of the minute `at` falls in. */
export function minuteOf(at: number): number {
  return Math.floor(at / MINUTE_MS) * MINUTE_MS;
}

/** Round to three places: a tenth of a percent, finer than any chart draws or any rule is set. */
export const round3 = (n: number): number => Math.round(n * 1000) / 1000;
/** Round to two places: a whole percent, what a spark is drawn at. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** A count that never wraps: past 65535 samples in one minute the average simply stops moving. */
const COUNT_MAX = 0xffff;

/**
 * One machine's day: a ring of {@link HISTORY_MINUTES} minutes, oldest at `head`, ordered by minute.
 * Index `i` (0 = oldest) lives at `(head + i) % HISTORY_MINUTES` in every array.
 */
class Series {
  /** The minute's start in whole minutes since the epoch (29 million today; an Int32 holds 2 billion). */
  private readonly minute = new Int32Array(HISTORY_MINUTES);
  private readonly n = new Uint16Array(HISTORY_MINUTES);
  private readonly cpu = new Float64Array(HISTORY_MINUTES);
  private readonly mem = new Float64Array(HISTORY_MINUTES);
  private readonly cpuMax = new Float32Array(HISTORY_MINUTES);
  private readonly rx = new Float32Array(HISTORY_MINUTES);
  private readonly rxN = new Uint16Array(HISTORY_MINUTES);
  private readonly tx = new Float32Array(HISTORY_MINUTES);
  private readonly txN = new Uint16Array(HISTORY_MINUTES);
  private head = 0;
  size = 0;

  private slot(i: number): number {
    return (this.head + i) % HISTORY_MINUTES;
  }

  /** The start, epoch ms, of the minute at index `i`. */
  t(i: number): number {
    return this.minute[this.slot(i)]! * MINUTE_MS;
  }

  lastT(): number | null {
    return this.size === 0 ? null : this.t(this.size - 1);
  }

  /** A new, empty minute at the end. A full ring drops its oldest minute to make room. */
  push(t: number): void {
    if (this.size === HISTORY_MINUTES) {
      this.head = (this.head + 1) % HISTORY_MINUTES;
      this.size -= 1;
    }
    const s = this.slot(this.size);
    this.minute[s] = Math.floor(t / MINUTE_MS);
    this.n[s] = 0;
    this.cpu[s] = 0;
    this.mem[s] = 0;
    this.cpuMax[s] = 0;
    this.rx[s] = 0;
    this.rxN[s] = 0;
    this.tx[s] = 0;
    this.txN[s] = 0;
    this.size += 1;
  }

  /** Fold one sample into the newest minute. */
  fold(sample: MachineSample): void {
    const s = this.slot(this.size - 1);
    const n = Math.min(COUNT_MAX, this.n[s]! + 1);
    this.n[s] = n;
    this.cpu[s] = this.cpu[s]! + (sample.cpu - this.cpu[s]!) / n;
    this.mem[s] = this.mem[s]! + (sample.memUsed / sample.memTotal - this.mem[s]!) / n;
    this.cpuMax[s] = Math.max(this.cpuMax[s]!, sample.cpu);
    if (sample.rxBps !== undefined) {
      const k = Math.min(COUNT_MAX, this.rxN[s]! + 1);
      this.rxN[s] = k;
      this.rx[s] = this.rx[s]! + (sample.rxBps - this.rx[s]!) / k;
    }
    if (sample.txBps !== undefined) {
      const k = Math.min(COUNT_MAX, this.txN[s]! + 1);
      this.txN[s] = k;
      this.tx[s] = this.tx[s]! + (sample.txBps - this.tx[s]!) / k;
    }
  }

  /** Append one minute read back from the file, already averaged. Out-of-order rows are refused. */
  load(m: LoadedMinute): void {
    const last = this.lastT();
    if (last !== null && m.t <= last) return;
    this.push(m.t);
    const s = this.slot(this.size - 1);
    const n = Math.min(COUNT_MAX, Math.max(1, Math.round(m.n)));
    this.n[s] = n;
    this.cpu[s] = m.cpu;
    this.mem[s] = m.mem;
    this.cpuMax[s] = m.cpuMax;
    if (m.rx !== null) {
      this.rx[s] = m.rx;
      this.rxN[s] = n;
    }
    if (m.tx !== null) {
      this.tx[s] = m.tx;
      this.txN[s] = n;
    }
  }

  /** Drop the newest `count` minutes. */
  popTail(count: number): void {
    this.size = Math.max(0, this.size - count);
  }

  /** Drop the oldest `count` minutes. */
  shiftHead(count: number): void {
    const k = Math.min(count, this.size);
    this.head = (this.head + k) % HISTORY_MINUTES;
    this.size -= k;
  }

  /** The index of the first minute starting at or after `t`, or `size` when none does. */
  firstAtOrAfter(t: number): number {
    let lo = 0;
    let hi = this.size;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.t(mid) < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  point(i: number): MachineHistoryPoint {
    const s = this.slot(i);
    return [
      this.t(i),
      round3(this.cpu[s]!),
      round3(this.cpuMax[s]!),
      round3(this.mem[s]!),
      this.rxN[s] === 0 ? null : Math.round(this.rx[s]!),
      this.txN[s] === 0 ? null : Math.round(this.tx[s]!),
    ];
  }

  reading(i: number): MinuteReading {
    const s = this.slot(i);
    return { t: this.t(i), cpu: this.cpu[s]!, mem: this.mem[s]! };
  }

  /** The file's row for index `i`, given the start of the row before it. */
  row(i: number, previousT: number | null): (number | null)[] {
    const s = this.slot(i);
    const t = this.t(i);
    return [
      previousT === null ? 0 : Math.round((t - previousT) / MINUTE_MS),
      round3(this.cpu[s]!),
      round3(this.cpuMax[s]!),
      round3(this.mem[s]!),
      this.rxN[s] === 0 ? null : Math.round(this.rx[s]!),
      this.txN[s] === 0 ? null : Math.round(this.tx[s]!),
    ];
  }

  lastCount(): number {
    return this.size === 0 ? 0 : this.n[this.slot(this.size - 1)]!;
  }
}

/**
 * Cut the minutes that start more than {@link FUTURE_SLACK_MS} after the minute `now` falls in. The
 * ring is ordered, so they are a tail. Whether anything was cut.
 */
function dropFuture(series: Series, now: number): boolean {
  const ceiling = minuteOf(now) + FUTURE_SLACK_MS;
  const keep = series.firstAtOrAfter(ceiling + 1);
  if (keep === series.size) return false;
  series.popTail(series.size - keep);
  return true;
}

export class MachineHistory {
  private readonly machines = new Map<string, Series>();
  private changed = false;

  constructor(loaded: ReadonlyMap<string, readonly LoadedMinute[]> = new Map()) {
    for (const [id, minutes] of loaded) {
      if (minutes.length === 0) continue;
      const series = new Series();
      // The newest day only: a file holding more is cut to the ring's length.
      for (const m of minutes.slice(-HISTORY_MINUTES)) series.load(m);
      this.machines.set(id, series);
    }
  }

  /** Whether anything moved since the last {@link MachineHistory.markSaved}. */
  dirty(): boolean {
    return this.changed;
  }

  markSaved(): void {
    this.changed = false;
  }

  /** Fold one sample into its minute. `at` is the receiving bridge's clock (§10.2), never a peer's. */
  record(id: string, sample: MachineSample, at: number): void {
    const t = minuteOf(at);
    let series = this.machines.get(id);
    if (series === undefined) {
      series = new Series();
      this.machines.set(id, series);
    }
    // A clock that jumped back by more than the slack leaves minutes "in the future". Folding into
    // them would hide every new sample in a minute the chart draws hours ahead, and an alert would
    // judge nothing until the clock caught up, so they go.
    if (dropFuture(series, at)) this.changed = true;
    const last = series.lastT();
    // A clock that stepped backwards a little lands its sample in a minute already closed. Folding it
    // into the newest minute keeps the ring ordered, which is what every reader below relies on.
    if (last === null || last < t) series.push(t);
    series.fold(sample);
    this.changed = true;
  }

  /**
   * Drop every minute older than a day, and every minute in the future beyond {@link FUTURE_SLACK_MS}.
   * Called before every read and every save, and on load.
   */
  prune(now: number): void {
    const floor = minuteOf(now) - DAY_MS;
    for (const [id, series] of this.machines) {
      if (dropFuture(series, now)) this.changed = true;
      const keep = series.firstAtOrAfter(floor + 1);
      if (keep > 0) {
        series.shiftHead(keep);
        this.changed = true;
      }
      if (series.size === 0) this.machines.delete(id);
    }
  }

  /** Forget one machine: a member that left the crew takes its history with it. */
  drop(id: string): void {
    if (this.machines.delete(id)) this.changed = true;
  }

  /** Keep only the machines in `ids`. A member removed while this bridge was down goes here. */
  retain(ids: ReadonlySet<string>): void {
    // Deleting the entry being visited is safe in a Map iteration; the walk skips nothing.
    for (const id of this.machines.keys()) if (!ids.has(id)) this.drop(id);
  }

  /**
   * The wire's points, oldest first: `[t, cpuAvg, cpuMax, memFrac, rxBps | null, txBps | null]`, the
   * fractions to three places. With `since`, only the minutes starting at or after it: the page asks
   * for the whole day once, then only for what it has not seen.
   */
  points(id: string, now: number, since?: number): MachineHistoryPoint[] {
    this.prune(now);
    const series = this.machines.get(id);
    if (series === undefined) return [];
    const out: MachineHistoryPoint[] = [];
    for (let i = since === undefined ? 0 : series.firstAtOrAfter(since); i < series.size; i++) out.push(series.point(i));
    return out;
  }

  /** The complete minutes since `from` (inclusive), for the alert evaluator. The open minute is left out. */
  minutes(id: string, from: number, now: number): MinuteReading[] {
    const series = this.machines.get(id);
    if (series === undefined) return [];
    const open = minuteOf(now);
    const out: MinuteReading[] = [];
    for (let i = series.firstAtOrAfter(from); i < series.size && series.t(i) < open; i++) out.push(series.reading(i));
    return out;
  }

  /**
   * The last `count` COMPLETE minutes of CPU and memory, oldest first, to two places, `null` for a
   * minute with no reading, for the dashboard's small charts (`GET /api/machines?spark=N`). The open
   * minute is left out, so a spark changes once a minute and never wobbles while a minute fills.
   * Leading empty minutes are cut, so a machine watched for five minutes has five values; `null` when
   * none of the minutes has a reading.
   */
  spark(id: string, now: number, count: number): MachineSpark | null {
    const series = this.machines.get(id);
    if (series === undefined) return null;
    const open = minuteOf(now);
    const from = open - count * MINUTE_MS;
    const cpu: (number | null)[] = [];
    const mem: (number | null)[] = [];
    let i = series.firstAtOrAfter(from);
    for (let t = from; t < open; t += MINUTE_MS) {
      if (i < series.size && series.t(i) === t) {
        const r = series.reading(i);
        cpu.push(round2(r.cpu));
        mem.push(round2(r.mem));
        i += 1;
      } else if (cpu.length > 0) {
        cpu.push(null);
        mem.push(null);
      }
    }
    if (cpu.length === 0) return null;
    return { stepMs: MINUTE_MS, cpu, mem };
  }

  /** The persisted form, version 2 (the header above). */
  toFile(now: number): MachineHistoryFile {
    this.prune(now);
    const machines: MachineHistoryFile["machines"] = {};
    for (const [id, series] of this.machines) {
      const rows: (number | null)[][] = [];
      let previous: number | null = null;
      for (let i = 0; i < series.size; i++) {
        rows.push(series.row(i, previous));
        previous = series.t(i);
      }
      machines[id] = { t: series.t(0), n: series.lastCount(), rows };
    }
    return { version: 2, machines };
  }
}

/** Write the store, atomically and owner-only: a fresh temp file at 0600, then a rename over the target. */
export async function saveMachineHistory(stateDir: string, history: MachineHistory, now: number): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const file = join(stateDir, MACHINE_HISTORY_FILE);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(history.toFile(now)), { mode: 0o600 });
  await rename(tmp, file);
}

/**
 * The store as the last save left it, with every minute older than a day already gone. A missing or
 * unreadable file is an empty store: history is a cache of the last day, and nothing depends on it.
 */
export async function loadMachineHistory(stateDir: string, now: number): Promise<MachineHistory> {
  let raw: JsonValue | undefined;
  try {
    raw = await Bun.file(join(stateDir, MACHINE_HISTORY_FILE)).json();
  } catch {
    raw = undefined;
  }
  const history = new MachineHistory(coerceHistoryFile(raw, HISTORY_MINUTES));
  history.prune(now);
  history.markSaved();
  return history;
}
