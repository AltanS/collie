// Linux and macOS lock table readers for session discovery.
//
// Linux exposes process file locks in `/proc/locks` as `<major>:<minor>:<inode>`, which any
// unprivileged process can read regardless of mount namespace isolation (such as systemd services
// with `PrivateTmp=yes`, where inspecting `/proc/<pid>/fd/*` via `lsof` or `readlink` fails with EACCES).
//
// On macOS, which has no `/proc/locks`, lock holders are discovered through `openFiles` (`lsof`).
//
// WHICH FILE A LOCK ROW NAMES. A row names the file by its filesystem's device (`i_sb->s_dev`) and
// inode. `stat(2)` mostly reports the same device, and then the match is exact. btrfs is the known
// exception: `stat` reports the subvolume's anonymous device (major 0, say `0:57`) while the row
// names the filesystem's (`0:36`). An inode number alone names nothing, it repeats across
// filesystems and across the subvolumes of one btrfs. So {@link heldCandidates} only bridges the
// two devices through the kernel's own answer: `/proc/self/mountinfo` prints `s_dev` of the mount
// that holds the file, the same number `/proc/locks` prints. Measured on Linux 7.2 btrfs: stat
// `0:57`, lock row `00:24` (0:36), mountinfo `0:36`. That still cannot tell two subvolumes of one
// filesystem apart, so the candidate's inode number must also be unique among the candidates.

import { readFile, realpath } from "node:fs/promises";
import { HOST } from "../host.ts";

export interface ProcReader {
  /** The files `pid` holds a FLOCK write lock on, as `<major>:<minor>:<inode>`, or null when the table cannot be read. */
  flocks(pid: number): Promise<Set<string> | null>;
  /**
   * The text of the bridge's own mount table (`/proc/self/mountinfo`), or null where there is none.
   * A reader without it gets exact matches only.
   */
  mounts?(): Promise<string | null>;
}

/**
 * The files `pid` holds a FLOCK write lock on, from the text of /proc/locks, as
 * `<major>:<minor>:<inode>` in decimal. A row reads
 * `<n>: FLOCK  ADVISORY  WRITE <pid> <maj>:<min>:<inode> <start> <end>`, the device numbers in hex; a
 * blocked waiter's row starts `<n>: -> `, and is not a holder.
 */
export function flocksOf(table: string, pid: number): Set<string> {
  const held = new Set<string>();
  for (const row of table.split("\n")) {
    const fields = row.trim().split(/\s+/);
    if (fields[1] !== "FLOCK" || fields[3] !== "WRITE" || Number(fields[4]) !== pid) continue;
    const [major, minor, inode] = (fields[5] ?? "").split(":");
    if (!/^[0-9a-f]+$/i.test(major ?? "") || !/^[0-9a-f]+$/i.test(minor ?? "") || !/^\d+$/.test(inode ?? "")) continue;
    held.add(`${Number.parseInt(major ?? "", 16)}:${Number.parseInt(minor ?? "", 16)}:${inode}`);
  }
  return held;
}

function majorOf(dev: bigint): bigint {
  return ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn);
}

function minorOf(dev: bigint): bigint {
  return (dev & 0xffn) | ((dev >> 12n) & ~0xffn);
}

/** A file's identity in the lock table's terms, `<major>:<minor>:<inode>`, from Linux's dev_t encoding. */
export function fileKey(dev: bigint, ino: bigint): string {
  return `${majorOf(dev)}:${minorOf(dev)}:${ino}`;
}

/** A mountinfo path field with its octal escapes (`\040` for a space) undone. */
function unescapeMountPath(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

/**
 * The `<major>:<minor>` of the mount that holds the real path `path`, from the text of
 * /proc/self/mountinfo, or null when no row holds it. A row reads
 * `<id> <parent> <maj>:<min> <root> <mount point> <options> [<tags>...] - <type> <source> <options>`,
 * the device in decimal. The deepest mount point wins; of two at one point, the later row (the one
 * mounted on top). A row of another shape is skipped.
 */
export function mountDevice(table: string, path: string): string | null {
  let best: { depth: number; dev: string } | null = null;
  for (const row of table.split("\n")) {
    const fields = row.split(" ");
    if (fields.length < 10 || !fields.includes("-", 6)) continue;
    const dev = fields[2] ?? "";
    if (!/^\d+:\d+$/.test(dev)) continue;
    const point = unescapeMountPath(fields[4] ?? "");
    if (!point.startsWith("/")) continue;
    const inside = point === "/" || path === point || path.startsWith(`${point}/`);
    if (!inside) continue;
    const depth = point === "/" ? 0 : point.length;
    if (best === null || depth >= best.depth) best = { depth, dev };
  }
  return best?.dev ?? null;
}

/** A file a discoverer is choosing from, with its `stat` identity. */
export interface LockCandidate {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

/**
 * The candidates whose file is one of `locked`, the lock table rows of the pids discovery asked about.
 *
 * An exact `<major>:<minor>:<inode>` match is a match. When any candidate matches exactly, only the
 * exact matches count, so a filesystem where `stat` and `/proc/locks` agree behaves as an exact match
 * alone would.
 *
 * Only when none matches exactly may a candidate match across the btrfs device split (see the header),
 * and only when all hold: its own device is an anonymous one (major 0); no other candidate has its
 * inode number; the reader has a mount table; and the lock row names the device of the mount that
 * holds the candidate's real path, with its inode. A candidate that fails any of these is not held.
 */
export async function heldCandidates<T extends LockCandidate>(
  locked: ReadonlySet<string>,
  candidates: readonly T[],
  proc: ProcReader,
): Promise<T[]> {
  const exact = candidates.filter((c) => locked.has(fileKey(c.dev, c.ino)));
  if (exact.length > 0 || locked.size === 0 || proc.mounts === undefined) return exact;
  const inodes = new Map<bigint, number>();
  for (const c of candidates) inodes.set(c.ino, (inodes.get(c.ino) ?? 0) + 1);
  const anonymous = candidates.filter((c) => majorOf(c.dev) === 0n && inodes.get(c.ino) === 1);
  if (anonymous.length === 0) return [];
  const table = await proc.mounts().catch(() => null);
  if (table === null) return [];
  const held: T[] = [];
  for (const c of anonymous) {
    const real = await realpath(c.path).catch(() => null);
    if (real === null) continue;
    const dev = mountDevice(table, real);
    if (dev !== null && locked.has(`${dev}:${c.ino}`)) held.push(c);
  }
  return held;
}

/** The real /proc on Linux. Off Linux every answer is null. */
export const LINUX_PROC: ProcReader = {
  async flocks(pid) {
    if (HOST.platform !== "linux") return null;
    const table = await readFile("/proc/locks", "utf8").catch(() => null);
    return table === null ? null : flocksOf(table, pid);
  },
  async mounts() {
    if (HOST.platform !== "linux") return null;
    return readFile("/proc/self/mountinfo", "utf8").catch(() => null);
  },
};
