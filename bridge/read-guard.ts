// THE BOUND A CLIENT-NAMED READ STAYS INSIDE — shared by the Files view (bridge/files-view.ts, ADR
// 0083) and the Changes view (bridge/changes.ts, ADR 0065), so the two views apply ONE containment and
// never two (ADR 0150). Files' header holds the rules this module enforces; this file is the code:
//
//   - {@link resolveReadRoot}: the root's REAL path, a folder, and (unless the caller holds the Files
//     right and asks for an unbounded root) never `/`, home, or a folder above home, on the real and
//     the given spelling of both.
//   - {@link isDeniedPath}: a `.git` segment, a state secret's basename, or the inside of the bridge's
//     own state or config folder. Case-folded on every host.
//   - {@link checkedTarget}: a path's real path, inside the root's real path and not denied.
//   - {@link readHeadUnder}: one regular file read through {@link NODE_FILES_FS}'s `readHead`, no
//     final link followed, and checked AGAIN on the opened handle before a byte is read.
//
// ── THE RACE, AND THE CHECK ON THE OPENED FILE ──────────────────────────────────────────────────
// Between the containment check and the read, a path component can be swapped for a symlink. The
// final component is opened with O_NOFOLLOW (POSIX) so a swap of the file itself fails the open,
// O_NONBLOCK so a FIFO swapped in cannot hang the request, and the opened handle must be a regular
// file. A swap of a folder ABOVE it would still open a file elsewhere, so containment is checked a
// SECOND time, on the handle, before a byte is read ({@link openedFileAllowed}):
//   - Linux: the kernel's own name for the open file (`/proc/self/fd/<fd>`) must lie inside the
//     root's real path and pass the deny rules. That name is the file the handle holds, so no later
//     swap can change the answer.
//   - Elsewhere (no `/proc`): the path is resolved and checked again, and its `lstat` must be the
//     handle's own file (same device and inode). A swap still in place fails the containment; a swap
//     put back fails the identity.
// A hard link cannot be told apart by either check: it is the same inode under a name inside the
// root, so its real path and the kernel's name are both inside. It is served. Making one needs write
// access inside the root and (with Linux's `protected_hardlinks`) ownership of the target, which is
// the agent running as the operator's own user, and that agent can already read every file the
// bridge can. A file with more than one link is not refused either: package managers (pnpm) and
// tools hard-link ordinary files, and refusing them would refuse the files a root is made of.

import { constants, type Dirent } from "node:fs";
import { lstat, open, opendir, readlink, stat } from "node:fs/promises";

import { isStateSecretName } from "./acl-policy.ts";
import { isAbsoluteFolder, withinBound } from "./changes-root.ts";
import { HOST, type Host, isInside, splitPath } from "./host.ts";
import { containedRealpath, realpathOf } from "./journal/files.ts";

// ── The disk, injectable ────────────────────────────────────────────────────────────────────────

/** The stat fields this module reads. */
export interface FilesStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: number;
  /** The file's identity, compared against an open handle's ({@link openedFileAllowed}). */
  dev?: number;
  ino?: number;
}

/**
 * The file an open handle holds, as the check on the opened file reads it. `path` is the kernel's
 * own name for it (Linux, `/proc/self/fd/<fd>`), or null where there is no such name to ask.
 */
export interface OpenedFile {
  path: string | null;
  dev: number;
  ino: number;
}

/** The file calls a bounded read makes. {@link NODE_FILES_FS} in production. */
export interface FilesFs {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<FilesStat>;
  lstat(path: string): Promise<FilesStat>;
  /** Up to `limit` names in `dir`, in the order the disk gives them, and whether more were there. */
  names(dir: string, limit: number, keep: (name: string) => boolean): Promise<{ names: string[]; more: boolean }>;
  /**
   * Open `path` without following a final symlink, refuse anything but a regular file, ask
   * `confirm` about the opened file BEFORE any byte is read, and read at most `max` bytes from its
   * start. `null` when the open, the type check or `confirm` refused it.
   */
  readHead(
    path: string,
    max: number,
    confirm?: (opened: OpenedFile) => Promise<boolean>,
  ): Promise<{ bytes: Uint8Array; size: number; mtimeMs?: number } | null>;
  /** The real path containment, `containedRealpath` in production. */
  contained(candidate: string, root: string, host: Host): Promise<string | null>;
}

/** O_NOFOLLOW and O_NONBLOCK exist on POSIX only; Windows reads them as 0 (no flag). */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * The kernel's name for an open descriptor, on Linux, or null. `/proc/self/fd/<fd>` is a link the
 * kernel answers from the open file itself, so it names the file the handle holds, not whatever a
 * path names now. A file deleted since the open reads as `<path> (deleted)`, which is no path inside
 * any root, so it is refused.
 */
async function kernelPathOf(fd: number): Promise<string | null> {
  if (HOST.platform !== "linux") return null;
  return readlink(`/proc/self/fd/${String(fd)}`).catch(() => null);
}

export const NODE_FILES_FS: FilesFs = {
  realpath: (path) => realpathOf(path),
  stat: (path) => stat(path),
  lstat: (path) => lstat(path),
  async names(dir, limit, keep) {
    const handle = await opendir(dir);
    const names: string[] = [];
    let more = false;
    try {
      let entry: Dirent | null;
      while ((entry = await handle.read()) !== null) {
        if (!keep(entry.name)) continue;
        if (names.length >= limit) {
          more = true;
          break;
        }
        names.push(entry.name);
      }
    } finally {
      await handle.close().catch(() => {});
    }
    return { names, more };
  },
  async readHead(path, max, confirm) {
    const handle = await open(path, OPEN_FLAGS).catch(() => null);
    if (handle === null) return null;
    try {
      const st = await handle.stat();
      if (!st.isFile()) return null;
      if (confirm !== undefined && !(await confirm({ path: await kernelPathOf(handle.fd), dev: st.dev, ino: st.ino }))) {
        return null;
      }
      const want = Math.min(st.size, max);
      const bytes = new Uint8Array(want);
      let got = 0;
      while (got < want) {
        const { bytesRead } = await handle.read(bytes, got, want - got, got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      // The mtime is the open handle's own, read with the size: the phone keys a held picture on both
      // (ADR 0090), and a second path lookup could name another file than the one these bytes came from.
      return { bytes: bytes.subarray(0, got), size: st.size, mtimeMs: st.mtimeMs };
    } finally {
      await handle.close().catch(() => {});
    }
  },
  contained: (candidate, root, host) => containedRealpath(candidate, root, host),
};

// ── What is never shown ─────────────────────────────────────────────────────────────────────────

/** A `.git` segment, on every host case-folded: refused for list and read, hidden from listings. */
export function isGitSegment(name: string): boolean {
  return name.toLowerCase() === ".git";
}

/** A host that folds case whatever the platform: the deny checks err towards refusing. */
export function foldingHost(host: Host): Host {
  return host.caseInsensitive ? host : { ...host, caseInsensitive: true };
}

/**
 * Each private folder as given and as its real path, whichever spelling a target reaches. Shared
 * with the New page's folder browser (bridge/folder-browse.ts), which denies the same folders.
 */
export async function deniedFolders(privateFolders: readonly string[], fs: Pick<FilesFs, "realpath"> = NODE_FILES_FS): Promise<string[]> {
  const denied: string[] = [];
  for (const folder of privateFolders) {
    if (folder.trim() === "") continue;
    denied.push(folder);
    const real = await fs.realpath(folder).catch(() => null);
    if (real !== null && real !== folder) denied.push(real);
  }
  return denied;
}

/**
 * Whether a real path is one these views never show: a `.git` segment, a state secret's basename, or
 * a private folder's inside (`denied`, from {@link deniedFolders}). Case-folded on every host.
 */
export function isDeniedPath(real: string, denied: readonly string[], host: Host = HOST): boolean {
  const parts = splitPath(host, real).parts;
  if (parts.some(isGitSegment)) return true;
  const base = parts.at(-1);
  if (base !== undefined && isStateSecretName(base)) return true;
  const fold = foldingHost(host);
  return denied.some((folder) => isInside(fold, real, folder));
}

// ── The root ────────────────────────────────────────────────────────────────────────────────────

/** What a bounded read needs to pick and check its root. */
export interface ReadRootInput {
  /** The root off the snapshot, never the client's. */
  root: string;
  /** The operator's home folder, the bound's upper end. */
  home: string;
  /** The bridge's state folder and config folder: denied, and hidden from listings. */
  privateFolders: readonly string[];
  host?: Host;
  fs?: FilesFs;
}

/** The pieces one request works with, after the root has been checked. */
export interface ReadRoot {
  rootReal: string;
  /** Each private folder as given and as its real path; whichever spelling a target reaches. */
  denied: string[];
  host: Host;
  fs: FilesFs;
}

/**
 * The root's real path, when it is a folder and its real path is still narrow enough to read:
 * never `/`, home, or a folder above home, on the real paths of both. `null` reads as `no-folder`.
 *
 * `unbounded` drops the bound and nothing else: only the Changes view asks for it, and only for a
 * caller that holds the Files right (`device-read`, ADR 0150). The real path, the folder check and the
 * deny list stay.
 */
export async function resolveReadRoot(input: ReadRootInput, opts: { unbounded?: boolean } = {}): Promise<ReadRoot | null> {
  const host = input.host ?? HOST;
  const fs = input.fs ?? NODE_FILES_FS;
  if (!isAbsoluteFolder(input.root, host)) return null;
  const rootReal = await fs.realpath(input.root).catch(() => null);
  if (rootReal === null) return null;
  const st = await fs.stat(rootReal).catch(() => null);
  if (st === null || !st.isDirectory()) return null;
  if (opts.unbounded !== true && !(await isBoundedReal(rootReal, input.home, host, fs))) return null;
  const denied = await deniedFolders(input.privateFolders, fs);
  return { rootReal, denied, host, fs };
}

/**
 * Whether a REAL folder is narrow enough to read: inside the bound against home as given and against
 * home's real path. The bound that {@link resolveReadRoot} applies to a root, and the Changes view's
 * walk up applies to each folder it passes.
 */
export async function isBoundedReal(real: string, home: string, host: Host = HOST, fs: Pick<FilesFs, "realpath"> = NODE_FILES_FS): Promise<boolean> {
  const homeReal = await fs.realpath(home).catch(() => home);
  return withinBound(real, homeReal, host) && withinBound(real, home, host);
}

function isDeniedReal(real: string, r: ReadRoot): boolean {
  return isDeniedPath(real, r.denied, r.host);
}

/**
 * The real path of `segments` under the root, when it is inside the root and not denied. `null` is
 * `unknown-path`, whatever the cause.
 */
export async function checkedTarget(segments: readonly string[], r: ReadRoot): Promise<string | null> {
  const last = segments.at(-1);
  if (last !== undefined && isStateSecretName(last)) return null;
  const candidate = segments.length === 0 ? r.rootReal : r.host.path.join(r.rootReal, ...segments);
  const real = await r.fs.contained(candidate, r.rootReal, r.host);
  if (real === null) return null;
  return isDeniedReal(real, r) ? null : real;
}

/**
 * The check on the OPENED file (see "THE RACE, AND THE CHECK ON THE OPENED FILE" above): whether the
 * file a handle holds is still the one {@link checkedTarget} allowed. `real` is what that check
 * answered for `segments` before the open.
 *
 * With the kernel's name for the handle (Linux), that name must lie inside the root's real path and
 * pass the same deny rules; nothing that happens to the path afterwards changes which file the handle
 * holds. Without one, the path is checked again from the start and must answer `real` once more, and
 * the file there must be the handle's own (device and inode), so a folder swapped and swapped back
 * around the open is caught by the identity, and one still swapped by the containment.
 */
export function openedFileAllowed(segments: readonly string[], r: ReadRoot, real: string) {
  return async (opened: OpenedFile): Promise<boolean> => {
    if (opened.path !== null) {
      return isInside(r.host, opened.path, r.rootReal) && !isDeniedReal(opened.path, r);
    }
    const again = await checkedTarget(segments, r).catch(() => null);
    if (again !== real) return false;
    const st = await r.fs.lstat(again).catch(() => null);
    if (st === null || st.isSymbolicLink() || !st.isFile()) return false;
    return st.dev !== undefined && st.ino !== undefined && st.dev === opened.dev && st.ino === opened.ino;
  };
}

/**
 * The first `max` bytes of one regular file under the root, through {@link checkedTarget} and the
 * check on the opened handle ({@link openedFileAllowed}): the Files read, for a caller that has its
 * segments already. `null` for every refusal.
 */
export async function readHeadUnder(
  r: ReadRoot,
  segments: readonly string[],
  max: number,
): Promise<{ bytes: Uint8Array; size: number; mtimeMs?: number } | null> {
  if (segments.length === 0) return null;
  const real = await checkedTarget(segments, r);
  if (real === null) return null;
  return r.fs.readHead(real, max, openedFileAllowed(segments, r, real));
}
