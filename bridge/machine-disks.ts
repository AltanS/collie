// How full this machine's disks are: the filesystems that hold the home folder, the root (on Windows
// the system drive) and Collie's state folder, read with `statfs` (ADR 0084).
//
// ── NEVER ON THE TICK'S OWN TIME ─────────────────────────────────────────────
// A `statfs` on a hung network mount does not return, and the tick must never wait for one. So every
// read here is async and fire-and-forget: the tick STARTS a round when one is due and returns at once,
// and the round's answer lands in `DiskWatch` whenever it comes. Each path is its own slot. A slot
// whose read is still out when the next round is due is skipped, never stacked, so a hung home mount
// costs one pending promise, not one per minute, and does not stop the root or the state folder from
// being read. A slot whose last answer is older than {@link DISK_STALE_MS} is not reported at all: no
// stale percentage pretends to be current. No child process, ever (`df` is not an option).
//
// ── ONE READ A MINUTE ────────────────────────────────────────────────────────
// Disks fill slowly. {@link DISK_READ_MS} is the most often a round starts, on the sampler's tick;
// between rounds every sample carries the last answer.
//
// ── WHICH FILESYSTEMS COUNT ──────────────────────────────────────────────────
// A Fedora Atomic root is a 34 MiB composefs image, read-only, at 100 %: not a full disk, and it must
// never show or alert. So a filesystem is dropped when it is smaller than {@link MIN_DISK_BYTES}, or
// read-only with no free block at all (Linux reads `ro` off `/proc/self/mounts`; elsewhere no free
// block, the root reserve included, stands in for it). Two paths on one device are one disk, and so
// are two filesystems that report the same type, size and free space (APFS volumes in one container,
// btrfs subvolumes): the fuller is kept. At most {@link MAX_DISKS}.
//
// ── THE NUMBERS MATCH `df` ───────────────────────────────────────────────────
// `used` is `df`'s Used (blocks minus free blocks) and `total` is `used + available to an unprivileged
// user`, so `used / total` is `df`'s Use% and `total - used` is the space a normal process can still
// write. `df`'s Size column also counts the blocks reserved for root, so `total` can be a few percent
// under it.

import type { MachineDisk } from "./types.ts";

/** The most often a round of reads starts. */
export const DISK_READ_MS = 60_000;
/** A slot whose last answer is older than this is not reported: three rounds missed. */
export const DISK_STALE_MS = 3 * DISK_READ_MS + 30_000;
/** A filesystem smaller than this is an image or a boot partition, not a disk worth a line. */
export const MIN_DISK_BYTES = 1024 ** 3;
/** At most this many disks in a sample. */
export const MAX_DISKS = 4;

/** What `statfs` answers, the fields this file reads. `frsize` where the runtime gives it. */
export interface StatFsLike {
  type: number;
  bsize: number;
  frsize?: number;
  blocks: number;
  bfree: number;
  bavail: number;
}

/** What one round needs from the outside world. Every call may reject or never resolve. */
export interface DiskReaders {
  readonly platform: NodeJS.Platform;
  /** The paths to read: home, root (or the system drive), the state folder. */
  readonly paths: readonly string[];
  readonly statfs: (path: string) => Promise<StatFsLike>;
  /** The device id of a path, for de-duplication and for finding its mount point. */
  readonly dev: (path: string) => Promise<number | bigint>;
  /** The path with every symlink resolved. */
  readonly realpath: (path: string) => Promise<string>;
  /** `/proc/self/mounts` on Linux, `null` elsewhere or when it cannot be read. */
  readonly mounts: () => Promise<string | null>;
  readonly now: () => number;
}

/** One filesystem as a round found it, before the cross-path rules. */
export interface DiskReading {
  mount: string;
  used: number;
  total: number;
  /** Device id, or `null` when the platform gave none. */
  dev: string | null;
  type: number;
  avail: number;
}

// ── Pure parts ───────────────────────────────────────────────────────────────

/** The mount points `/proc/self/mounts` names as read-only. Octal escapes (`\040` for a space) decoded. */
export function readOnlyMounts(text: string): Set<string> {
  const ro = new Set<string>();
  for (const line of text.split("\n")) {
    const cols = line.split(" ");
    if (cols.length < 4) continue;
    const mount = cols[1]!.replace(/\\([0-7]{3})/g, (_m, oct: string) => String.fromCharCode(Number.parseInt(oct, 8)));
    const opts = cols[3]!.split(",");
    // A later line for the same mount point covers the earlier one.
    if (opts.includes("ro")) ro.add(mount);
    else ro.delete(mount);
  }
  return ro;
}

/** The label a Windows path is shown by: its drive, `C:`. A UNC path keeps `\\server\share`. */
export function windowsLabel(path: string): string {
  const drive = /^([A-Za-z]:)/.exec(path);
  if (drive) return drive[1]!.toUpperCase();
  const unc = /^(\\\\[^\\]+\\[^\\]+)/.exec(path);
  return unc ? unc[1]! : path;
}

/**
 * One filesystem's numbers, or `null` when it does not count: too small, read-only and full, or a
 * nonsense answer. `readOnly` is what the platform could tell (Linux only): `null` is "could not
 * tell", which is not the same as `false`.
 */
export function diskOf(
  mount: string,
  s: StatFsLike,
  dev: string | null,
  readOnly: boolean | null,
): DiskReading | null {
  const unit = s.frsize !== undefined && s.frsize > 0 ? s.frsize : s.bsize;
  const ok = [unit, s.blocks, s.bfree, s.bavail].every((n) => Number.isFinite(n) && n >= 0);
  if (!ok || !(unit > 0) || s.blocks <= 0) return null;
  if (s.blocks * unit < MIN_DISK_BYTES) return null;
  // No free block at all, the root reserve included: an image, not a disk that filled up. Where the
  // mount table was read the flag says it outright, and a full xfs, btrfs, tmpfs, NTFS or f2fs (its
  // bfree is 0 too) stays on the card. Only with no mount table is "no free block" the sign there is.
  if (s.bavail === 0 && (readOnly === null ? s.bfree === 0 : readOnly)) return null;
  const used = Math.max(0, s.blocks - s.bfree) * unit;
  const avail = Math.min(s.bavail, s.blocks) * unit;
  const total = used + avail;
  if (!(total > 0)) return null;
  return { mount, used, total, dev, type: s.type, avail };
}

/**
 * The cross-path rules: one disk per device, one per shared pool (same type, size and free space),
 * the fuller kept, at most {@link MAX_DISKS}, in the order the paths were given.
 */
export function pickDisks(readings: readonly DiskReading[]): MachineDisk[] {
  const kept: DiskReading[] = [];
  for (const r of readings) {
    const same = kept.findIndex(
      (k) => (k.dev !== null && k.dev === r.dev) || (k.type === r.type && k.total === r.total && k.avail === r.avail),
    );
    if (same < 0) kept.push(r);
    else if (r.used > kept[same]!.used) kept[same] = r;
  }
  return kept.slice(0, MAX_DISKS).map((k) => ({ mount: k.mount, used: k.used, total: k.total }));
}

/** The fullest disk's fraction, or `null` with none. What the history and the alert judge. */
export function fullestFraction(disks: readonly MachineDisk[] | undefined): number | null {
  if (disks === undefined || disks.length === 0) return null;
  let max = 0;
  for (const d of disks) if (d.total > 0) max = Math.max(max, d.used / d.total);
  return Math.min(1, max);
}

// ── The watch ────────────────────────────────────────────────────────────────

interface Slot {
  pending: boolean;
  /** The last answer, and when it came. `null` value: the path did not count. */
  value: DiskReading | null;
  at: number;
}

/**
 * The disks of this machine, refreshed by fire-and-forget rounds (see the header). `tick()` never
 * waits and never throws; `current()` is what the next sample carries.
 */
export class DiskWatch {
  private readonly slots = new Map<string, Slot>();
  private lastRound = Number.NEGATIVE_INFINITY;
  private roMounts: Set<string> | null = null;

  constructor(private readonly r: DiskReaders) {
    for (const p of r.paths) if (!this.slots.has(p)) this.slots.set(p, { pending: false, value: null, at: Number.NEGATIVE_INFINITY });
  }

  /** Start a round when one is due. Returns at once; the answers land later. */
  tick(): void {
    const now = this.r.now();
    // A negative gap is a clock that stepped back: the round is due, not held until it catches up.
    const gap = now - this.lastRound;
    if (gap >= 0 && gap < DISK_READ_MS) return;
    this.lastRound = now;
    if (this.r.platform === "linux") void this.readMounts();
    for (const [path, slot] of this.slots) {
      if (slot.pending) continue;
      slot.pending = true;
      void this.fill(path, slot);
    }
  }

  /** One slot's read, start to answer. Never rejects: a failure is an answer of "does not count". */
  private async fill(path: string, slot: Slot): Promise<void> {
    try {
      slot.value = await this.readOne(path);
    } catch {
      slot.value = null;
    } finally {
      slot.at = this.r.now();
      slot.pending = false;
    }
  }

  private async readMounts(): Promise<void> {
    try {
      const text = await this.r.mounts();
      if (text !== null) this.roMounts = readOnlyMounts(text);
    } catch {
      // No mount table: the read-only test falls back to "no free block at all".
    }
  }

  /** The disks to report now: fresh slots only, after the cross-path rules. Empty when none counts. */
  current(): MachineDisk[] {
    const now = this.r.now();
    const fresh: DiskReading[] = [];
    for (const slot of this.slots.values()) {
      // An answer stamped in the future (the clock stepped back) ages from now, not never.
      if (slot.at > now) slot.at = now;
      if (slot.value === null || now - slot.at > DISK_STALE_MS) continue;
      // The read-only flag may arrive after the statfs; a mount it names drops out here too.
      if (this.roMounts?.has(slot.value.mount) && slot.value.avail === 0) continue;
      fresh.push(slot.value);
    }
    return pickDisks(fresh);
  }

  /** Tests and the cost note: how many reads are out right now. */
  pendingReads(): number {
    let n = 0;
    for (const s of this.slots.values()) if (s.pending) n += 1;
    return n;
  }

  private async readOne(path: string): Promise<DiskReading | null> {
    const real = await this.r.realpath(path).catch(() => path);
    const stats = await this.r.statfs(real);
    const devOf = async (p: string): Promise<string | null> => {
      try {
        return String(await this.r.dev(p));
      } catch {
        return null;
      }
    };
    const dev = await devOf(real);
    const mount = this.r.platform === "win32" ? windowsLabel(real) : await this.mountOf(real, dev, devOf);
    return diskOf(mount, stats, dev, this.roMounts === null ? null : this.roMounts.has(mount));
  }

  /** The topmost folder above `path` on the same device: its mount point. The path itself without ids. */
  private async mountOf(path: string, dev: string | null, devOf: (p: string) => Promise<string | null>): Promise<string> {
    if (dev === null) return path;
    let at = path;
    for (let depth = 0; depth < 64 && at !== "/"; depth += 1) {
      const cut = at.lastIndexOf("/");
      const parent = cut <= 0 ? "/" : at.slice(0, cut);
      if ((await devOf(parent)) !== dev) return at;
      at = parent;
    }
    return at;
  }
}
