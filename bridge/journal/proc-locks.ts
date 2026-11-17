// Linux and macOS lock table readers for session discovery.
//
// Linux exposes process file locks in `/proc/locks` as `<major>:<minor>:<inode>`, which any
// unprivileged process can read regardless of mount namespace isolation (such as systemd services
// with `PrivateTmp=yes`, where inspecting `/proc/<pid>/fd/*` via `lsof` or `readlink` fails with EACCES).
//
// On macOS, which has no `/proc/locks`, lock holders are discovered through `openFiles` (`lsof`).

import { readFile } from "node:fs/promises";
import { HOST } from "../host.ts";

export interface ProcReader {
  flocks(pid: number): Promise<Set<string> | null>;
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

/** A file's identity in the lock table's terms, `<major>:<minor>:<inode>`, from Linux's dev_t encoding. */
export function fileKey(dev: bigint, ino: bigint): string {
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn);
  const minor = (dev & 0xffn) | ((dev >> 12n) & ~0xffn);
  return `${major}:${minor}:${ino}`;
}

/** The real /proc/locks on Linux. Off Linux every answer is null. */
export const LINUX_PROC: ProcReader = {
  async flocks(pid) {
    if (HOST.platform !== "linux") return null;
    const table = await readFile("/proc/locks", "utf8").catch(() => null);
    return table === null ? null : flocksOf(table, pid);
  },
};
