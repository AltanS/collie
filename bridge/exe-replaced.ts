// Has the binary this process is EXECUTING been replaced on disk?
//
// The question a package manager forces. `pacman -U` (and every other package manager) unlinks the
// old `bin/collie` and writes a new one in its place, then restarts nothing: the service stays up on
// the deleted inode, serving the old code, while the files around it describe the new version. The
// version comparison in `bridge/update.ts` catches that only when the version STRING moved — a
// pkgrel rebuild of the same version is invisible to it, and the running process is just as stale.
//
// So this module answers from the executable itself rather than from a version file, and it is
// PURE: the caller collects the evidence (a readlink, two `stat`s, a process start time) and this
// decides. That is what lets `collie doctor` ask it about ANOTHER process's pid and the bridge ask
// it about itself, from one implementation and one set of rules.
//
// It lives in `bridge/` because both sides need it and the dependency direction is one-way — `cli/`
// imports from `bridge/`, never the other way.

/** What Linux appends to `/proc/<pid>/exe` once the file behind it is unlinked. */
export const DELETED_SUFFIX = " (deleted)";

/**
 * Everything the decision reads. Every field is nullable because every one of them is a probe that
 * can decline: `/proc` is Linux-only, a `stat` fails on a path this user may not read, and a process
 * start time is not available everywhere.
 */
export interface ExeEvidence {
  /** `readlink /proc/<pid>/exe` — the executed path, with {@link DELETED_SUFFIX} when it is gone. */
  readonly exeLink: string | null;
  /** The inode of the executable the process is running, read THROUGH the `/proc` link. */
  readonly exeInode: number | null;
  /** The inode of the file that now sits at that path. */
  readonly installedInode: number | null;
  /** Last modification of the file that now sits at that path, epoch ms. */
  readonly installedMtimeMs: number | null;
  /** When the process started, epoch ms. */
  readonly startedAtMs: number | null;
}

/**
 * `unknown` is a first-class answer, and the reason this is a three-way rather than a boolean: a
 * probe that could not run must not read as "current". A check that says nothing is honest; one
 * that says "fine" on no evidence is the thing an operator skips a real look on.
 */
export type ExeVerdict = "replaced" | "current" | "unknown";

/** The executed path with the deleted marker taken off, or null when there was no link to read. */
export function exePathOf(exeLink: string | null): string | null {
  if (exeLink === null) return null;
  return exeLink.endsWith(DELETED_SUFFIX) ? exeLink.slice(0, -DELETED_SUFFIX.length) : exeLink;
}

/**
 * Three questions in order of how much they prove.
 *
 * 1. The link says `(deleted)`. The kernel is stating the fact outright — nothing else is consulted.
 * 2. Both inodes are known. Equal is current, different is replaced. This is the case a package
 *    manager that wrote a NEW file at the same path lands in, and it holds for a same-version
 *    rebuild, which is exactly what the version comparison misses.
 * 3. Neither of those could be answered, but the file's mtime and the process's start time both
 *    were. A file modified after the process started is a file this process is not running. It is
 *    the weakest of the three — a touched file with identical content trips it — so it comes last,
 *    and it is the only rule available off Linux.
 *
 * Anything else is `unknown`. Note that a REPLACED file is never mistaken for `current` by rule 3
 * alone: the mtime of the new file is newer than the start of the process it replaced under.
 */
export function classifyExe(evidence: ExeEvidence): ExeVerdict {
  const { exeLink, exeInode, installedInode, installedMtimeMs, startedAtMs } = evidence;
  if (exeLink !== null && exeLink.endsWith(DELETED_SUFFIX)) return "replaced";
  if (exeInode !== null && installedInode !== null) {
    return exeInode === installedInode ? "current" : "replaced";
  }
  if (installedMtimeMs !== null && startedAtMs !== null) {
    return installedMtimeMs > startedAtMs ? "replaced" : "current";
  }
  return "unknown";
}

/** The boolean the bridge's snapshot wants: raised only on a verdict, never on silence. */
export function exeReplaced(evidence: ExeEvidence): boolean {
  return classifyExe(evidence) === "replaced";
}
