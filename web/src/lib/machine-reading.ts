// What a machine's row can honestly say right now, as one word the Machines cards and the detail
// page both switch on, so the two never disagree about a machine.
//
//   live   reachable, and its last reading is recent: the numbers are the machine now.
//   stale  reachable, but no new reading for STALE_AFTER_MS. The lead skips a reading that repeats
//          the last one in every number (a member whose sampler hangs), so its age grows while the
//          link is fine. The numbers are shown, quieted, with their age in words.
//   older  reachable, and it never sent a reading: a Collie from before machines reported load.
//   quiet  not reachable (unreachable, incompatible, conflicted). Its age, and no numbers: a stale
//          12 % beside "unreachable" reads as a calm machine.
//
// Every age is against the answer's own `ts`, never `Date.now()` (lib/host-health.ts argues why).

import type { MachineDisk, MachineRow } from "./types";

/**
 * How old a reachable machine's reading may get before it is called stale. A member samples about
 * every 15 to 24 s and the lead sees each sample within one sweep, so two minutes is several missed
 * readings in a row, never one slow one.
 */
export const STALE_AFTER_MS = 120_000;

export type MachineReading = "live" | "stale" | "older" | "quiet";

export function machineReading(row: MachineRow, ts: number): MachineReading {
  if (row.health !== "reachable") return "quiet";
  if (row.sample === undefined) return "older";
  if (row.sampledAt !== undefined && ts - row.sampledAt > STALE_AFTER_MS) return "stale";
  return "live";
}

/**
 * The fullest filesystem a sample reports, and its fraction: what the card's "Disk" figure, the disk
 * chart and the disk alert all read, so the three name the same disk. `null` with no disks.
 */
export function fullestDisk(disks: readonly MachineDisk[] | undefined): { disk: MachineDisk; fraction: number } | null {
  let best: { disk: MachineDisk; fraction: number } | null = null;
  for (const disk of disks ?? []) {
    const fraction = diskFraction(disk);
    if (best === null || fraction > best.fraction) best = { disk, fraction };
  }
  return best;
}

/** One filesystem's used fraction, 0 to 1, guarded against a zero total. */
export function diskFraction(disk: MachineDisk): number {
  return disk.total > 0 ? Math.min(1, Math.max(0, disk.used / disk.total)) : 0;
}
