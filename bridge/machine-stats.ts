// What this machine is doing right now: CPU, memory and network, sampled from the existing tick.
//
// ── PURE PARSERS, ONE READER, NO CHILD PROCESS ───────────────────────────────
// Every number comes from a file the kernel already keeps or from `node:os`, never from `top`, `ps`,
// `vm_stat` or `typeperf`. A spawn on the poll path would cost more than the reading is worth, and
// Collie runs no long-lived child for content (CLAUDE.md, Security posture). The parsers below take
// text and return numbers, and the one reader takes its file and `os` access as parameters, so
// `bun test` drives a Linux, a macOS-like and a Windows-like host on any machine.
//
// ── WHY LINUX READS /proc/stat AND NOT os.cpus() ─────────────────────────────
// Measured on 2026-10-05 under Bun 1.4.1 on Fedora (16 cores): `os.cpus()` reports `user`, `nice`,
// `sys`, `idle` and `irq` per core, each exactly ten times the matching `/proc/stat` column. It leaves
// out `iowait`, `softirq` and `steal`. Over three seconds of an idle desktop those columns held 11 %
// of all time, so the busy fraction from `os.cpus()` read 12.4 % where `/proc/stat` read 11.3 %, and
// the gap grows with disk wait. So Linux reads the aggregate `cpu` line and counts `iowait` as idle,
// the way `top` does. Every other platform sums `os.cpus()`, which is all it offers without a spawn.
//
// ── NO TIMER ─────────────────────────────────────────────────────────────────
// {@link MachineSampler.tick} is called from the state engine's tick (CREW_PROTOCOL.md §10.1, §11:
// no second timer) and reads at most once every {@link SAMPLE_MIN_INTERVAL_MS}. A crew snapshot
// answer never reads anything: it serves {@link MachineSampler.latest}, the last sample held.

import type { CpuInfo } from "node:os";
import type { Host } from "./host.ts";
import type { MachineSample } from "./types.ts";

/** The fastest a machine samples itself. The tick runs at 1.5 s, or 12 s when nobody is looking. */
export const SAMPLE_MIN_INTERVAL_MS = 5_000;

// ── Pure parsers ─────────────────────────────────────────────────────────────

/** Cumulative CPU counters at one instant. The unit is the source's own; only a delta means anything. */
export interface CpuTimes {
  readonly busy: number;
  readonly total: number;
}

/**
 * The aggregate `cpu` line of `/proc/stat`: user, nice, system, idle, iowait, irq, softirq, steal.
 *
 * `guest` and `guest_nice` follow and are NOT added: the kernel already counts them inside `user` and
 * `nice`. `iowait` is idle time with a disk request outstanding, so it counts as idle. A kernel that
 * prints fewer columns (very old ones stop after `idle`) still parses; one that prints fewer than four
 * does not.
 */
export function parseProcStat(text: string): CpuTimes | null {
  const line = text.split("\n").find((l) => l.startsWith("cpu "));
  if (line === undefined) return null;
  const cols = line.trim().split(/\s+/).slice(1, 9).map(Number);
  if (cols.length < 4 || cols.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const total = cols.reduce((a, b) => a + b, 0);
  const idle = cols[3]! + (cols[4] ?? 0);
  return { busy: total - idle, total };
}

/** The same counters summed over `os.cpus()`. `null` for an empty list, which some sandboxes return. */
export function cpuTimesFromOs(cpus: readonly CpuInfo[]): CpuTimes | null {
  if (cpus.length === 0) return null;
  let busy = 0;
  let idle = 0;
  for (const { times } of cpus) {
    busy += times.user + times.nice + times.sys + times.irq;
    idle += times.idle;
  }
  if (!Number.isFinite(busy) || !Number.isFinite(idle)) return null;
  return { busy, total: busy + idle };
}

/**
 * The busy fraction between two readings, or `null` when the two say nothing: no time passed, or a
 * counter went backwards (a CPU taken offline, or a counter reset). Clamped to 0..1, because two
 * separate reads of a fast-moving counter can disagree by a tick.
 */
export function cpuFraction(prev: CpuTimes, next: CpuTimes): number | null {
  const total = next.total - prev.total;
  const busy = next.busy - prev.busy;
  if (!(total > 0) || busy < 0) return null;
  return Math.min(1, Math.max(0, busy / total));
}

/**
 * `/proc/meminfo` as bytes in use and in total. Used is `MemTotal - MemAvailable`: the kernel's own
 * estimate of what could be handed out without swapping, so page cache does not read as pressure.
 * A kernel older than 3.14 has no `MemAvailable`; free plus buffers plus cache is the old estimate.
 */
export function parseMeminfo(text: string): { used: number; total: number } | null {
  const kb = new Map<string, number>();
  for (const line of text.split("\n")) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (m !== null) kb.set(m[1]!, Number(m[2]));
  }
  const total = kb.get("MemTotal");
  if (total === undefined || total <= 0) return null;
  const available =
    kb.get("MemAvailable") ?? (kb.get("MemFree") ?? 0) + (kb.get("Buffers") ?? 0) + (kb.get("Cached") ?? 0);
  const used = Math.min(total, Math.max(0, total - available));
  return { used: used * 1024, total: total * 1024 };
}

/** Received and sent byte counters per interface. */
export type NetCounters = ReadonlyMap<string, { readonly rx: number; readonly tx: number }>;

/**
 * `/proc/net/dev`: two header lines, then `iface: rx_bytes … (8 receive columns) tx_bytes …`.
 * Loopback is left out: it is traffic between two processes on this machine, not load on a link.
 */
export function parseNetDev(text: string): NetCounters | null {
  const out = new Map<string, { rx: number; tx: number }>();
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    if (name === "" || name === "lo") continue;
    const cols = line.slice(colon + 1).trim().split(/\s+/).map(Number);
    if (cols.length < 9) continue;
    const rx = cols[0]!;
    const tx = cols[8]!;
    if (!Number.isFinite(rx) || !Number.isFinite(tx) || rx < 0 || tx < 0) continue;
    out.set(name, { rx, tx });
  }
  return out.size === 0 && !text.includes("|") ? null : out;
}

/**
 * Bytes per second between two readings, summed over the interfaces present in BOTH.
 *
 * Per interface rather than over the totals, so an interface that comes or goes between two reads (a
 * container's veth, a VPN coming up) adds nothing instead of a jump, and a counter that went
 * backwards (a driver reset) is skipped rather than read as negative traffic.
 */
export function netRate(prev: NetCounters, next: NetCounters, dtMs: number): { rx: number; tx: number } | null {
  if (!(dtMs > 0)) return null;
  let rx = 0;
  let tx = 0;
  for (const [name, now] of next) {
    const was = prev.get(name);
    if (was === undefined) continue;
    const drx = now.rx - was.rx;
    const dtx = now.tx - was.tx;
    if (drx < 0 || dtx < 0) continue;
    rx += drx;
    tx += dtx;
  }
  return { rx: (rx * 1000) / dtMs, tx: (tx * 1000) / dtMs };
}

// ── The reader ───────────────────────────────────────────────────────────────

/** The `node:os` calls the reader makes. Injected, so a test pins a host. */
export interface OsReader {
  cpus(): CpuInfo[];
  totalmem(): number;
  freemem(): number;
  loadavg(): number[];
}

export interface MachineReaders {
  readonly host: Host;
  /**
   * A whole text file, or `null` when it cannot be read. Only Linux's `/proc` files are ever asked
   * for, and those live in memory, so a synchronous read costs microseconds and never a disk seek.
   */
  readonly readText: (path: string) => string | null;
  readonly os: OsReader;
  readonly now: () => number;
}

/** Counters at one instant. Each half is `null` when its source said nothing usable. */
interface Counters {
  readonly at: number;
  readonly cpu: CpuTimes | null;
  readonly cores: number;
  readonly mem: { used: number; total: number } | null;
  readonly load1: number | null;
  readonly net: NetCounters | null;
}

/** Call `fn`, and read a throw as "this source said nothing". A reading must never break the tick. */
function attempt<T>(fn: () => T | null): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

function readCounters(r: MachineReaders): Counters {
  const linux = r.host.platform === "linux";
  const cpus = attempt(() => r.os.cpus()) ?? [];
  const cpu = (linux ? attempt(() => parseProcStat(r.readText("/proc/stat") ?? "")) : null) ?? cpuTimesFromOs(cpus);
  const mem =
    (linux ? attempt(() => parseMeminfo(r.readText("/proc/meminfo") ?? "")) : null) ??
    attempt(() => {
      const total = r.os.totalmem();
      const free = r.os.freemem();
      if (!(total > 0) || !(free >= 0)) return null;
      return { used: Math.min(total, Math.max(0, total - free)), total };
    });
  // Windows has no load average, and Node answers `[0, 0, 0]` there rather than nothing. A zero that
  // means "not measured" is not a load, so the key is left out on that host.
  const load1 =
    r.host.platform === "win32"
      ? null
      : attempt(() => {
          const value = r.os.loadavg()[0];
          return value !== undefined && Number.isFinite(value) && value >= 0 ? value : null;
        });
  const net = linux ? attempt(() => parseNetDev(r.readText("/proc/net/dev") ?? "")) : null;
  return { at: r.now(), cpu, cores: cpus.length, mem, load1, net };
}

/**
 * This machine's own sampler. Holds the previous counters and the last sample, and nothing else.
 *
 * The first reading has nothing to take a delta against, so it yields no sample: a busy fraction
 * needs two readings, and a sample without one would be half a sample.
 */
export class MachineSampler {
  private prev: Counters | null = null;
  private last: MachineSample | null = null;

  constructor(
    private readonly readers: MachineReaders,
    private readonly minIntervalMs = SAMPLE_MIN_INTERVAL_MS,
  ) {}

  /**
   * Read, at most once every {@link SAMPLE_MIN_INTERVAL_MS}. Returns the sample this call produced,
   * or `null` when it read nothing new (too soon, the first reading, or a source that failed).
   */
  tick(): MachineSample | null {
    const now = this.readers.now();
    if (this.prev !== null && now - this.prev.at < this.minIntervalMs) return null;
    const next = readCounters(this.readers);
    const prev = this.prev;
    this.prev = next;
    if (prev === null) return null;
    const sample = composeSample(prev, next);
    if (sample !== null) this.last = sample;
    return sample;
  }

  /** The last sample taken, or `null` before the second reading. What a crew snapshot answer serves. */
  latest(): MachineSample | null {
    return this.last;
  }
}

function composeSample(prev: Counters, next: Counters): MachineSample | null {
  if (prev.cpu === null || next.cpu === null || next.mem === null || next.cores <= 0) return null;
  const cpu = cpuFraction(prev.cpu, next.cpu);
  if (cpu === null) return null;
  const sample: MachineSample = { cpu, cores: next.cores, memUsed: next.mem.used, memTotal: next.mem.total };
  if (next.load1 !== null) sample.load1 = next.load1;
  if (prev.net !== null && next.net !== null) {
    const rate = netRate(prev.net, next.net, next.at - prev.at);
    if (rate !== null) {
      sample.rxBps = rate.rx;
      sample.txBps = rate.tx;
    }
  }
  return isMachineSample(sample) ? sample : null;
}

// ── The wire ─────────────────────────────────────────────────────────────────

/**
 * The sibling a peer adds to its `/crew/v1/snapshot` answer (CREW_PROTOCOL.md §5, §7.1).
 *
 * Beside the body, never inside it, for the reason the warrant pair and `updatePreflight` are: the
 * body is the object this collie serves its own browser.
 */
export const CREW_MACHINE_FIELD = "machineStats";

/** Upper bounds a real machine stays far below. A value past one is a broken sender, not a big host. */
const MAX_CORES = 65_536;
const MAX_BYTES = 2 ** 60;
const MAX_LOAD = 1_000_000;

function finiteIn(v: number, min: number, max: number): boolean {
  return Number.isFinite(v) && v >= min && v <= max;
}

/**
 * Whether every field of a sample is a finite number in its range. The one test the sampler and the
 * lead's reader of a member's sample (`machine-parse.ts`) share, so the two cannot disagree.
 */
export function isMachineSample(s: MachineSample): boolean {
  if (!finiteIn(s.cpu, 0, 1)) return false;
  if (!Number.isInteger(s.cores) || !finiteIn(s.cores, 1, MAX_CORES)) return false;
  if (!finiteIn(s.memTotal, 1, MAX_BYTES) || !finiteIn(s.memUsed, 0, s.memTotal)) return false;
  if (s.load1 !== undefined && !finiteIn(s.load1, 0, MAX_LOAD)) return false;
  if (s.rxBps !== undefined && !finiteIn(s.rxBps, 0, MAX_BYTES)) return false;
  if (s.txBps !== undefined && !finiteIn(s.txBps, 0, MAX_BYTES)) return false;
  return true;
}
