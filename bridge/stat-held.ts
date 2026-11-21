// ── A READ KEPT BEHIND A STAT, AND THE RACY-TIMESTAMP RULE ──────────────────────────────────────────────
//
// Several readers keep what they read from a file (a picture's version, the switch file, a trick's values, a
// folder's code hash, the paired-device registry) and read it again only when the file's stat moves. A stat does
// NOT move when a file is rewritten with the same size inside one timestamp tick: NTFS and some file systems keep
// the modified time in coarse steps, and a write right after a read can land in the same step. The reader then
// keeps the old content for good, until the next real change.
//
// The rule is the one git uses for its index ("racy timestamps"): a kept read is trusted only when the file was
// safely quiet before the read. While a file's last write is within RACY_WINDOW_MS of the read, EVERY look reads
// it again; once it has been quiet for the window, one more read settles it and a quiet file costs only its stat.
// Where the platform gives them, the inode and the change time are keyed too: a replace by rename moves both on
// POSIX. The window is the part that holds on Windows.
//
// It is for timestamp TIES: the race exists only while the file's time is close to the read. A time far in the
// past or far ahead of the clock (an archive unpacked with a zone-less time, a restored backup, a skewed mount) is
// safe to keep: the next real write sets the time to the present, which differs from the kept one. So a read is
// unsettled only while |read time - modified time| < RACY_WINDOW_MS. A modified time that is not a number uses the
// change time the same way; when neither is a number the read is never kept, and that is said once per path. The
// rule is not for a writer who restores the modified time on purpose: that one is seen only through the inode and
// the change time, where the platform gives them.

/**
 * How long a file must have been quiet before a read of it is kept. Two seconds: FAT keeps a modified time in
 * 2 s steps, NTFS and ext4 are finer, and a clock read and a file time can differ by a tick.
 */
export const RACY_WINDOW_MS = 2000;

/** The stat facts a kept read is keyed on. `ino` and `ctimeMs` are compared only when both sides have them. */
export interface StatFacts {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino?: number;
  readonly ctimeMs?: number;
}

/** The facts of a kept read, and whether that read may be kept. */
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

/**
 * Whether a read at `readAt` may be kept by the file's own times: the modified time, or the change time when the
 * modified time is not a number, is at least {@link RACY_WINDOW_MS} away from the read, before or after it. Null
 * when neither time is a number.
 */
export function quietBy(facts: { readonly mtimeMs: number; readonly ctimeMs?: number }, readAt: number): boolean | null {
  const time = Number.isFinite(facts.mtimeMs) ? facts.mtimeMs : facts.ctimeMs !== undefined && Number.isFinite(facts.ctimeMs) ? facts.ctimeMs : null;
  return time === null ? null : Math.abs(readAt - time) >= RACY_WINDOW_MS;
}

/** Whether a read taken at `readAt` of a file modified at `mtimeMs` may be kept by that time alone. */
export function settledAt(mtimeMs: number, readAt: number): boolean {
  return quietBy({ mtimeMs }, readAt) === true;
}

/** Who hears, once per path, that a file has no usable time and is never kept. */
export interface TimelessNote {
  /** The path, never its content. */
  path: string;
  /** What the file is, for the line: "a trick's picture", "the switch file". */
  kind: string;
  warn?: (line: string) => void;
}

const timelessSaid = new Set<string>();
const TIMELESS_SAID_MAX = 1000;

/** The record to keep beside a read of a file with these facts, taken at `readAt` (the clock before the read). */
export function holdStat(facts: StatFacts, readAt: number, note?: TimelessNote): StatHeld {
  const quiet = quietBy(facts, readAt);
  if (quiet === null && note !== undefined && !timelessSaid.has(note.path)) {
    if (timelessSaid.size >= TIMELESS_SAID_MAX) timelessSaid.clear();
    timelessSaid.add(note.path);
    (note.warn ?? ((line: string) => console.warn(`[stat] ${line}`)))(`${note.kind} at ${note.path} has no modified or change time this machine can read, so it is read again on every look`);
  }
  return { ...facts, settled: quiet === true };
}

/** Whether a kept read is still good for a file that stats as `now`: the same facts, and the read was settled. */
export function stillHolds(held: StatHeld | undefined, now: StatFacts): boolean {
  return held !== undefined && held.settled && sameStat(held, now);
}

/** Whether two stats name the same write: a re-read in the racy window of the same stat warns nothing new. */
export function sameStat(held: StatFacts | undefined, now: StatFacts): boolean {
  if (held === undefined) return false;
  if (held.size !== now.size || !sameTime(held.mtimeMs, now.mtimeMs)) return false;
  if (held.ino !== undefined && now.ino !== undefined && held.ino !== now.ino) return false;
  if (held.ctimeMs !== undefined && now.ctimeMs !== undefined && !sameTime(held.ctimeMs, now.ctimeMs)) return false;
  return true;
}

/** Two file times as the same write: equal, or both not a number (NaN never equals itself). */
function sameTime(a: number, b: number): boolean {
  return a === b || (Number.isNaN(a) && Number.isNaN(b));
}

/** Whether every entry of a folder walk read at `readAt` may be kept by its own times ({@link quietBy}). */
export function settledWalk(entries: readonly { readonly mtimeMs: number; readonly ctimeMs?: number }[], readAt: number): boolean {
  return entries.every((entry) => quietBy(entry, readAt) === true);
}
