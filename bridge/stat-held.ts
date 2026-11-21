// ── A READ KEPT BEHIND A STAT, AND THE RACY-TIMESTAMP RULE ──────────────────────────────────────────────
//
// Several readers in the tricks code keep what they read from a file (a picture's version, the switch file, a
// trick's values, a folder's code hash) and read it again only when the file's stat moves. A stat does NOT
// move when a file is rewritten with the same size inside one timestamp tick: NTFS and some file systems keep
// the modified time in coarse steps, and a write right after a read can land in the same step. The reader then
// keeps the old content for good, until the next real change.
//
// The rule is the one git uses for its index ("racy timestamps"): a kept read is trusted only when the file's
// modified time was safely older than the moment of the read. A file modified within RACY_WINDOW_MS of the read
// is read again on the next look, so a file that stopped changing costs at most one more read, and a quiet file
// costs nothing. Where the platform gives them, the inode and the change time are keyed too: a replace by rename
// moves both on POSIX. The window is the part that holds on Windows.

/**
 * How close to the read a file's modified time may be before the read is not trusted. Two seconds: FAT keeps a
 * modified time in 2 s steps, NTFS and ext4 are finer, and a clock read and a file time can differ by a tick.
 */
export const RACY_WINDOW_MS = 2000;

/** The stat facts a kept read is keyed on. `ino` and `ctimeMs` are compared only when both sides have them. */
export interface StatFacts {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino?: number;
  readonly ctimeMs?: number;
}

/** The facts of a kept read, and whether that read was safely after the file's last write. */
export interface StatHeld extends StatFacts {
  readonly settled: boolean;
}

/** {@link StatFacts} while {@link statFactsOf} fills it: the optional fields are set only when present. */
interface FactsBeingBuilt {
  size: number;
  mtimeMs: number;
  ino?: number;
  ctimeMs?: number;
}

/** The facts of a `stat` or `lstat` result. */
export function statFactsOf(st: { size: number; mtimeMs: number; ino?: number; ctimeMs?: number }): StatFacts {
  const facts: FactsBeingBuilt = { size: st.size, mtimeMs: st.mtimeMs };
  if (st.ino !== undefined) facts.ino = st.ino;
  if (st.ctimeMs !== undefined) facts.ctimeMs = st.ctimeMs;
  return facts;
}

/** Whether a read taken at `readAt` of a file modified at `mtimeMs` may be kept: the file was quiet for the window. */
export function settledAt(mtimeMs: number, readAt: number): boolean {
  return readAt - mtimeMs >= RACY_WINDOW_MS;
}

/** Whether a read of a folder walk taken at `readAt` may be kept: every entry was quiet for the window. */
export function settledWalk(entries: readonly { readonly mtimeMs: number; readonly ctimeMs?: number }[], readAt: number): boolean {
  return entries.every((entry) => settledAt(entry.mtimeMs, readAt));
}

/** The record to keep beside a read of a file with these facts, taken at `readAt` (the clock before the read). */
export function holdStat(facts: StatFacts, readAt: number): StatHeld {
  return { ...facts, settled: settledAt(facts.mtimeMs, readAt) };
}

/** Whether a kept read is still good for a file that stats as `now`: the same facts, and the read was settled. */
export function stillHolds(held: StatHeld | undefined, now: StatFacts): boolean {
  return held !== undefined && held.settled && sameStat(held, now);
}

/** Whether two stats name the same write: a re-read in the racy window of the same stat warns nothing new. */
export function sameStat(held: StatFacts | undefined, now: StatFacts): boolean {
  if (held === undefined) return false;
  if (held.size !== now.size || held.mtimeMs !== now.mtimeMs) return false;
  if (held.ino !== undefined && now.ino !== undefined && held.ino !== now.ino) return false;
  if (held.ctimeMs !== undefined && now.ctimeMs !== undefined && held.ctimeMs !== now.ctimeMs) return false;
  return true;
}
