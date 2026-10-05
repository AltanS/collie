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

import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "./json.ts";
import { coerceHistoryFile } from "./machine-parse.ts";
import type { MachineHistoryPoint, MachineSample } from "./types.ts";

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

/**
 * One minute of one machine: sums and counts, so a bucket can take another sample without keeping
 * the samples. Memory is kept as a fraction of that machine's total, which is what a chart and an
 * alert both read.
 */
export interface MinuteBucket {
  /** The minute's start, epoch ms. */
  t: number;
  /** Samples in this minute. Every sample carries cpu and memory, so this counts both. */
  n: number;
  cpuSum: number;
  cpuMax: number;
  memSum: number;
  rxSum: number;
  rxN: number;
  txSum: number;
  txN: number;
}

/** One complete minute as the alert evaluator reads it: the CPU average and the memory fraction. */
export interface MinuteReading {
  readonly t: number;
  readonly cpu: number;
  readonly mem: number;
}

/**
 * `machine-history.json`: per machine, one row per minute,
 * `[t, n, cpuSum, cpuMax, memSum, rxSum, rxN, txSum, txN]`. Read back by `coerceHistoryFile`.
 */
export interface MachineHistoryFile {
  version: 1;
  machines: Record<string, number[][]>;
}

/** The start of the minute `at` falls in. */
export function minuteOf(at: number): number {
  return Math.floor(at / MINUTE_MS) * MINUTE_MS;
}

/** Round to four places: a fraction to a hundredth of a percent, which no chart can draw finer. */
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/**
 * Cut the buckets that start more than {@link FUTURE_SLACK_MS} after the minute `now` falls in. The list
 * is ordered, so they are a tail. Whether anything was cut.
 */
function dropFuture(buckets: MinuteBucket[], now: number): boolean {
  const ceiling = minuteOf(now) + FUTURE_SLACK_MS;
  let cut = buckets.length;
  while (cut > 0 && buckets[cut - 1]!.t > ceiling) cut -= 1;
  if (cut === buckets.length) return false;
  buckets.length = cut;
  return true;
}

export class MachineHistory {
  private readonly machines = new Map<string, MinuteBucket[]>();
  private changed = false;

  constructor(loaded: ReadonlyMap<string, readonly MinuteBucket[]> = new Map()) {
    for (const [id, buckets] of loaded) this.machines.set(id, [...buckets]);
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
    let buckets = this.machines.get(id);
    if (buckets === undefined) {
      buckets = [];
      this.machines.set(id, buckets);
    }
    // A clock that jumped back by more than the slack leaves buckets "in the future". Folding into
    // them would hide every new sample in a minute the chart draws hours ahead, and an alert would
    // judge nothing until the clock caught up, so they go.
    if (dropFuture(buckets, at)) this.changed = true;
    let last = buckets.at(-1);
    // A clock that stepped backwards a little lands its sample in a minute already closed. Folding it
    // into the newest bucket keeps the list ordered, which is what every reader below relies on.
    if (last === undefined || last.t < t) {
      last = { t, n: 0, cpuSum: 0, cpuMax: 0, memSum: 0, rxSum: 0, rxN: 0, txSum: 0, txN: 0 };
      buckets.push(last);
      if (buckets.length > HISTORY_MINUTES) buckets.splice(0, buckets.length - HISTORY_MINUTES);
    }
    last.n += 1;
    last.cpuSum += sample.cpu;
    last.cpuMax = Math.max(last.cpuMax, sample.cpu);
    last.memSum += sample.memUsed / sample.memTotal;
    if (sample.rxBps !== undefined) {
      last.rxSum += sample.rxBps;
      last.rxN += 1;
    }
    if (sample.txBps !== undefined) {
      last.txSum += sample.txBps;
      last.txN += 1;
    }
    this.changed = true;
  }

  /**
   * Drop every bucket older than a day, and every bucket in the future beyond {@link FUTURE_SLACK_MS}.
   * Called before every read and every save, and on load.
   */
  prune(now: number): void {
    const floor = minuteOf(now) - DAY_MS;
    for (const [id, buckets] of this.machines) {
      if (dropFuture(buckets, now)) {
        this.changed = true;
        if (buckets.length === 0) {
          this.machines.delete(id);
          continue;
        }
      }
      const keep = buckets.findIndex((b) => b.t > floor);
      if (keep === 0) continue;
      this.changed = true;
      if (keep < 0) this.machines.delete(id);
      else buckets.splice(0, keep);
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

  /** The wire's points, oldest first: `[t, cpuAvg, cpuMax, memFrac, rxBps | null, txBps | null]`. */
  points(id: string, now: number): MachineHistoryPoint[] {
    this.prune(now);
    return (this.machines.get(id) ?? []).map((b) => [
      b.t,
      round4(b.cpuSum / b.n),
      round4(b.cpuMax),
      round4(b.memSum / b.n),
      b.rxN === 0 ? null : Math.round(b.rxSum / b.rxN),
      b.txN === 0 ? null : Math.round(b.txSum / b.txN),
    ]);
  }

  /** The complete minutes since `from` (inclusive), for the alert evaluator. The open minute is left out. */
  minutes(id: string, from: number, now: number): MinuteReading[] {
    const open = minuteOf(now);
    return (this.machines.get(id) ?? [])
      .filter((b) => b.t >= from && b.t < open)
      .map((b) => ({ t: b.t, cpu: b.cpuSum / b.n, mem: b.memSum / b.n }));
  }

  /** The persisted form. Sums are rounded, so a file is a few dozen kilobytes per machine per day. */
  toFile(now: number): MachineHistoryFile {
    this.prune(now);
    const machines: Record<string, number[][]> = {};
    for (const [id, buckets] of this.machines) {
      machines[id] = buckets.map((b) => [
        b.t,
        b.n,
        round4(b.cpuSum),
        round4(b.cpuMax),
        round4(b.memSum),
        Math.round(b.rxSum),
        b.rxN,
        Math.round(b.txSum),
        b.txN,
      ]);
    }
    return { version: 1, machines };
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
 * The store as the last save left it, with every bucket older than a day already gone. A missing or
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
