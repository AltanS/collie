// What this machine is doing right now: CPU, memory and network, sampled from the existing tick.
//
// ── PURE PARSERS, ONE READER, ONE SHORT CHILD ON macOS ONLY ──────────────────
// Every number comes from a file the kernel already keeps or from `node:os`, never from `top`, `ps`
// or `typeperf`. A spawn on the poll path would cost more than the reading is worth, and Collie runs
// no long-lived child for content (CLAUDE.md, Security posture). The one exception is macOS memory:
// `os.freemem()` there counts only free and speculative pages, so the file cache reads as used, and
// the number Activity Monitor shows (app + wired + compressed) is in no file. It comes from one
// short `/usr/bin/vm_stat` run per sample, see {@link parseVmStat}. The parsers below take text and
// return numbers, and the one reader takes its file, command and `os` access as parameters, so
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
// ── NO TIMER, AND A SLOW BASE RATE ───────────────────────────────────────────
// {@link MachineSampler.tick} is called from the state engine's tick (CREW_PROTOCOL.md §10.1, §11:
// no second timer). It reads at most once every {@link SAMPLE_IDLE_MS}, and at most once every
// {@link SAMPLE_WATCHED_MS} while a phone has asked for the Machines list in the last
// `MACHINES_WATCH_MS` (`bridge/machines.ts`): the same intent-driven idea as the poll cadence, so a
// bridge nobody looks at reads its machine a third as often. The alerts judge minute buckets, and
// the idle arithmetic is in `machines.ts` beside the watch. A crew snapshot answer never reads
// anything: it serves {@link MachineSampler.latest}, the last sample held.
//
// ── DISKS RIDE ALONG, ASYNC ──────────────────────────────────────────────────
// A sample carries the last answer of `DiskWatch` (bridge/machine-disks.ts), which this tick starts
// at most once a minute and never waits for: a `statfs` on a hung mount must not hold the tick.
//
// ── WHAT ONE SAMPLE COSTS ────────────────────────────────────────────────────
// Measured on 2026-10-05 under Bun 1.4.1 on a 16-core Fedora desktop with 33 network interfaces
// (Docker): about 0.2 ms, almost all of it in the kernel producing the three files (`/proc/net/dev`
// about 0.11 ms, `/proc/stat` 0.03 ms, `/proc/meminfo` 0.01 ms). The parsers below cost about 0.01 ms
// together, because each walks only the lines it needs. Linux takes its core count from the `cpuN`
// lines of `/proc/stat`, which it reads anyway, and never calls `os.cpus()`. Reading
// `/sys/class/net/<iface>/statistics` instead of `/proc/net/dev` was measured too, and was no cheaper.
// macOS is the exception: one `/usr/bin/vm_stat` process per sample, so at most one every
// {@link SAMPLE_WATCHED_MS} (5 s) and one every {@link SAMPLE_IDLE_MS} (15 s) otherwise. The run is
// async and fire-and-forget, like the disks: the tick STARTS `vm_stat` (`Bun.spawn`, killed after 1 s,
// bridge/index.ts) and returns at once, so a hung child can never hold the event loop. The answer is
// served on the NEXT sample, one tick late, and only one `vm_stat` runs at a time ({@link VmStatWatch}).
// The cost is not measured, no Mac was at hand; Apple's tool is a few `host_statistics64` calls and a
// print. Until the first answer exists, when it is older than {@link VM_STAT_MAX_AGE_MS}, or after a
// failure (no binary, timeout, unreadable output), memory falls back to `totalmem - freemem` silently.

import type { CpuInfo } from "node:os";
import { type DiskWatch, MAX_DISKS } from "./machine-disks.ts";
import type { Host } from "./host.ts";
import type { MachineDisk, MachineSample } from "./types.ts";

/**
 * The fastest a machine samples itself while a phone is watching its load (the Machines list, a
 * machine's page, the dashboard's Crew tab). The tick runs at 1.5 s, or 12 s while the multiplexer's
 * event stream is healthy, so a 12 s tick samples every 12 s here.
 */
export const SAMPLE_WATCHED_MS = 5_000;

/**
 * The fastest a machine samples itself otherwise: a lead or solo collie nobody is watching, and every
 * crew member (no phone asks a member, it answers its lead). On the 12 s idle tick that is a sample
 * every 24 s, two or three in every minute bucket.
 */
export const SAMPLE_IDLE_MS = 15_000;

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
  // The aggregate line is the file's first. Found by position rather than by splitting the whole file,
  // whose `intr` line alone runs to kilobytes on a machine with many interrupts.
  const newline = text.startsWith("cpu ") ? -1 : text.indexOf("\ncpu ");
  if (newline < 0 && !text.startsWith("cpu ")) return null;
  const at = newline + 1;
  const end = text.indexOf("\n", at);
  const line = text.slice(at, end < 0 ? undefined : end);
  const cols = line.trim().split(/\s+/).slice(1, 9).map(Number);
  if (cols.length < 4 || cols.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const total = cols.reduce((a, b) => a + b, 0);
  const idle = cols[3]! + (cols[4] ?? 0);
  return { busy: total - idle, total };
}

/**
 * The number of `cpuN` lines in `/proc/stat`: the online cores, the count `os.cpus()` reports on
 * Linux, taken from the file the sampler reads anyway. 0 when the file names none.
 */
export function procStatCores(text: string): number {
  let cores = 0;
  for (let at = text.indexOf("\ncpu"); at >= 0; at = text.indexOf("\ncpu", at + 4)) {
    const next = text.charCodeAt(at + 4);
    if (next >= 48 && next <= 57) cores += 1;
  }
  return cores;
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

/** One pattern per `/proc/meminfo` key the reader needs, each a whole line. The other fifty go unread. */
const MEMINFO_KEY = {
  MemTotal: /(?:^|\n)MemTotal:\s+(\d+)\s*kB/,
  MemFree: /(?:^|\n)MemFree:\s+(\d+)\s*kB/,
  MemAvailable: /(?:^|\n)MemAvailable:\s+(\d+)\s*kB/,
  Buffers: /(?:^|\n)Buffers:\s+(\d+)\s*kB/,
  Cached: /(?:^|\n)Cached:\s+(\d+)\s*kB/,
} as const;

function meminfoKb(text: string, key: RegExp): number | undefined {
  const m = key.exec(text);
  return m === null ? undefined : Number(m[1]);
}

/**
 * `/proc/meminfo` as bytes in use and in total. Used is `MemTotal - MemAvailable`: the kernel's own
 * estimate of what could be handed out without swapping, so page cache does not read as pressure.
 * A kernel older than 3.14 has no `MemAvailable`; free plus buffers plus cache is the old estimate.
 */
export function parseMeminfo(text: string): { used: number; total: number } | null {
  const total = meminfoKb(text, MEMINFO_KEY.MemTotal);
  if (total === undefined || total <= 0) return null;
  const available =
    meminfoKb(text, MEMINFO_KEY.MemAvailable) ??
    (meminfoKb(text, MEMINFO_KEY.MemFree) ?? 0) +
      (meminfoKb(text, MEMINFO_KEY.Buffers) ?? 0) +
      (meminfoKb(text, MEMINFO_KEY.Cached) ?? 0);
  const used = Math.min(total, Math.max(0, total - available));
  return { used: used * 1024, total: total * 1024 };
}

/**
 * `vm_stat` on macOS as bytes in use. Used is what Activity Monitor calls Memory Used: app memory plus
 * wired plus compressed, so the file cache (`File-backed pages`, inactive, speculative) is left out.
 *
 *   - App memory is `Anonymous pages - Pages purgeable`. `Anonymous pages` is the kernel's
 *     `internal_page_count`, which `host_statistics64` fills from `vm_page_pageable_internal_count`
 *     (xnu `osfmk/kern/host.c`), the counter `sysctl vm.page_pageable_internal_count` prints. Purgeable
 *     memory can be dropped on demand, so it does not count.
 *   - `Pages wired down` cannot be paged out.
 *   - `Pages occupied by compressor` is the memory the compressor itself takes, not the larger
 *     `Pages stored in compressor` it holds.
 *
 * Every count is in pages of the size the first line names (`page size of 16384 bytes` on Apple
 * silicon, 4096 on Intel). `null` when the page size or any of the four counts is missing, so a
 * format change reads as "no answer" and the caller falls back.
 */
export function parseVmStat(text: string): { used: number; pageSize: number } | null {
  const pageSize = /page size of (\d+) bytes/.exec(text);
  const anonymous = vmStatPages(text, "Anonymous pages");
  const purgeable = vmStatPages(text, "Pages purgeable");
  const wired = vmStatPages(text, "Pages wired down");
  const compressor = vmStatPages(text, "Pages occupied by compressor");
  if (pageSize === null || anonymous === null || purgeable === null || wired === null || compressor === null) {
    return null;
  }
  const size = Number(pageSize[1]);
  if (!(size > 0)) return null;
  const pages = Math.max(0, anonymous - purgeable) + wired + compressor;
  return { used: pages * size, pageSize: size };
}

/** One `vm_stat` line, `Label:      12345.`, as its count. `null` when the line is absent. */
function vmStatPages(text: string, label: string): number | null {
  const m = new RegExp(`(?:^|\\n)${label}:\\s+(\\d+)\\.`).exec(text);
  return m === null ? null : Number(m[1]);
}

/** Received and sent byte counters per interface. */
export type NetCounters = ReadonlyMap<string, { readonly rx: number; readonly tx: number }>;

/**
 * The interfaces whose bytes also cross another interface this reader counts, so counting them would
 * count the same traffic twice. The machine's load on its links is what the physical interfaces
 * carry (`eth*`, `en*`, `wl*`, `ww*`, `usb*` and the rest), and only they are summed.
 *
 *   - `lo`: traffic between two processes on this machine, on no link at all.
 *   - Bridges and their ports: `br*` (a host bridge `br0`, Docker's `br-<id>`), `docker*`, `virbr*`,
 *     `lxcbr*`, `lxdbr*`, `incusbr*`, `podman*`, `cni*`, `flannel*`, `cali*`, `cilium*`, `weave*`,
 *     `vxlan*`, and the veth and tap ends a container or VM plugs into them: `veth*`, `vnet*`, `tap*`.
 *     A container's traffic to the outside crosses its veth, the bridge AND the physical interface.
 *   - Tunnels: `tailscale*`, `wg*`, `tun*`, `zt*` (ZeroTier). Their traffic leaves through the
 *     physical interface too, encrypted, so the crew link's own bytes are counted once, there.
 *   - Aggregates: `bond*` and `team*`, whose member interfaces are physical and counted, and a VLAN
 *     on top of one, `eth0.100`, any name with a dot.
 *
 * A name that matches nothing here counts. A link this list does not know is counted twice at worst,
 * which reads as busier than it is; leaving a physical interface out would read as idle.
 */
const SKIPPED_INTERFACE =
  /^(?:lo$|br|docker|virbr|lxcbr|lxdbr|incusbr|podman|cni|flannel|cali|cilium|weave|vxlan|veth|vnet|tap|tailscale|wg|tun|zt|bond|team)|\./;

/** Whether `/proc/net/dev`'s interface `name` is one {@link parseNetDev} leaves out. */
export function isSkippedInterface(name: string): boolean {
  return SKIPPED_INTERFACE.test(name);
}

/**
 * `/proc/net/dev`: two header lines, then `iface: rx_bytes … (8 receive columns) tx_bytes …`.
 * Loopback, bridges, veth and tap ends, tunnels and aggregates are left out
 * ({@link isSkippedInterface}): their bytes are counted on a physical interface already.
 */
export function parseNetDev(text: string): NetCounters | null {
  const out = new Map<string, { rx: number; tx: number }>();
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    if (name === "" || isSkippedInterface(name)) continue;
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
  /**
   * Run one short command and resolve with its stdout, or `null` when it cannot run, fails or times
   * out. Never awaited by the tick (see {@link VmStatWatch}). Only macOS asks (`/usr/bin/vm_stat`,
   * once per sample). Absent in a harness that never runs one.
   */
  readonly run?: (command: string, args: readonly string[]) => Promise<string | null>;
  readonly os: OsReader;
  readonly now: () => number;
  /**
   * This machine's disks (bridge/machine-disks.ts): a round of async reads at most once a minute,
   * started from this tick and never awaited. Absent in a harness that does not test disks.
   */
  readonly disks?: DiskWatch;
}

/** Counters at one instant. Each half is `null` when its source said nothing usable. */
interface Counters {
  readonly at: number;
  readonly cpu: CpuTimes | null;
  /** Where `cpu` came from. Two readings from two sources count in two units, and give no delta. */
  readonly cpuSource: "proc" | "os";
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

/** Apple's tool, by absolute path, so a `PATH` with a shadowing `vm_stat` is never run. */
export const VM_STAT = "/usr/bin/vm_stat";

/**
 * How old a held `vm_stat` answer may be and still be served: three idle sample intervals. A sampler
 * that stopped getting answers (the binary is gone, every run times out) drifts back to
 * `totalmem - freemem` rather than serving a number from minutes ago.
 */
export const VM_STAT_MAX_AGE_MS = 3 * SAMPLE_IDLE_MS;

/**
 * The last parsed `vm_stat` answer, refreshed by fire-and-forget runs. {@link VmStatWatch.tick}
 * starts one run unless one is still in flight, and returns the held answer at once, so macOS memory
 * is served one tick late and the tick never waits on a child process (the way `DiskWatch` never
 * waits on a `statfs`). A run that fails, times out or prints something unparsable keeps the previous
 * answer, which then ages out after {@link VM_STAT_MAX_AGE_MS}.
 */
export class VmStatWatch {
  private held: { readonly used: number; readonly at: number } | null = null;
  private inFlight = false;

  constructor(
    private readonly run: (command: string, args: readonly string[]) => Promise<string | null>,
    private readonly now: () => number,
  ) {}

  /** Start a run when none is in flight; return the held bytes in use, or `null` when none is fresh. */
  tick(): number | null {
    if (!this.inFlight) {
      this.inFlight = true;
      void this.fill();
    }
    const held = this.held;
    return held !== null && this.now() - held.at <= VM_STAT_MAX_AGE_MS ? held.used : null;
  }

  private async fill(): Promise<void> {
    try {
      const text = await this.run(VM_STAT, []);
      const stat = text === null ? null : parseVmStat(text);
      if (stat !== null) this.held = { used: stat.used, at: this.now() };
    } catch {
      // A failed run reads as "no new answer".
    } finally {
      this.inFlight = false;
    }
  }
}

/** The vm_stat path for macOS memory, or `null` for the caller to fall back to `totalmem - freemem`. */
function darwinMemory(r: MachineReaders, watch: VmStatWatch | null): { used: number; total: number } | null {
  const used = watch?.tick() ?? null;
  const total = r.os.totalmem();
  if (used === null || !(total > 0)) return null;
  return { used: Math.min(total, Math.max(0, used)), total };
}

function readCounters(r: MachineReaders, vmStat: VmStatWatch | null): Counters {
  const linux = r.host.platform === "linux";
  // Linux: the busy counters and the core count both come off `/proc/stat`. `os.cpus()` is asked
  // only when that file said nothing usable, and on every other platform.
  const stat = linux ? attempt(() => r.readText("/proc/stat")) : null;
  let cpu = stat === null ? null : attempt(() => parseProcStat(stat));
  let cpuSource: Counters["cpuSource"] = "proc";
  let cores = stat === null ? 0 : procStatCores(stat);
  if (cpu === null || cores === 0) {
    const cpus = attempt(() => r.os.cpus()) ?? [];
    if (cpu === null) {
      cpu = cpuTimesFromOs(cpus);
      cpuSource = "os";
    }
    if (cores === 0) cores = cpus.length;
  }
  const mem =
    (linux ? attempt(() => parseMeminfo(r.readText("/proc/meminfo") ?? "")) : null) ??
    (r.host.platform === "darwin" ? attempt(() => darwinMemory(r, vmStat)) : null) ??
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
  return { at: r.now(), cpu, cpuSource, cores, mem, load1, net };
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
  /** Only a macOS host with a runner holds one. */
  private readonly vmStat: VmStatWatch | null;

  constructor(private readonly readers: MachineReaders) {
    this.vmStat =
      readers.host.platform === "darwin" && readers.run !== undefined ? new VmStatWatch(readers.run, readers.now) : null;
  }

  /**
   * Read, at most once every `minIntervalMs`: {@link SAMPLE_IDLE_MS} unless the caller says a phone
   * is watching. Returns the sample this call produced, or `null` when it read nothing new (too soon,
   * the first reading, or a source that failed). A call that is too soon reads nothing at all.
   *
   * Until the first sample exists, the floor is {@link SAMPLE_WATCHED_MS} at most: a sample needs two
   * readings, and a machine that just started (or a member that just joined) should show its load
   * within seconds, not after a whole idle interval. That costs one extra reading per start.
   */
  tick(minIntervalMs = SAMPLE_IDLE_MS): MachineSample | null {
    // Starts a round of disk reads when one is due, and returns at once (machine-disks.ts).
    this.readers.disks?.tick();
    const now = this.readers.now();
    const floor = this.last === null ? Math.min(minIntervalMs, SAMPLE_WATCHED_MS) : minIntervalMs;
    // A clock that stepped back makes the age negative: that reading is due, not "too soon" until the
    // clock catches up with the one it left behind.
    const age = this.prev === null ? Number.POSITIVE_INFINITY : now - this.prev.at;
    if (age >= 0 && age < floor) return null;
    const next = readCounters(this.readers, this.vmStat);
    const prev = this.prev;
    this.prev = next;
    if (prev === null) return null;
    const sample = composeSample(prev, next, this.readers.disks?.current() ?? []);
    if (sample !== null) this.last = sample;
    return sample;
  }

  /** The last sample taken, or `null` before the second reading. What a crew snapshot answer serves. */
  latest(): MachineSample | null {
    return this.last;
  }
}

function composeSample(prev: Counters, next: Counters, disks: MachineDisk[]): MachineSample | null {
  if (prev.cpu === null || next.cpu === null || next.mem === null || next.cores <= 0) return null;
  if (prev.cpuSource !== next.cpuSource) return null;
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
  if (disks.length > 0) sample.disks = disks;
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
/** A mount label longer than this is not a path anyone typed. */
const MAX_MOUNT_CHARS = 512;

/** A C0 control character or DEL: nothing a mount label shown on a phone may carry. */
function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

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
  if (s.disks !== undefined) {
    if (s.disks.length === 0 || s.disks.length > MAX_DISKS) return false;
    for (const d of s.disks) {
      if (d.mount.length === 0 || d.mount.length > MAX_MOUNT_CHARS || hasControlChar(d.mount)) return false;
      if (!finiteIn(d.total, 1, MAX_BYTES) || !finiteIn(d.used, 0, d.total)) return false;
    }
  }
  return true;
}
