import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

import { isHiddenChar } from "../../web/src/lib/hidden-chars.ts";

// THE CODE OF A TRICK, AS ONE HASH (M94): what a person approves when they switch a trick on.
//
// The switch stores this hash (switches.ts), and the bridge runs a copy of exactly those bytes
// (approved.ts). So an edited program, a swapped `run` line or a new helper file is a new version that
// waits for a person's yes, and the copy holds the walk's files and no others. The hash is a SHA-256 over every file of the folder that is code: the sorted
// relative paths, each with its kind and its bytes. Not code, so never hashed:
//
//   * `config.toml` at the top: the person's settings for the program. Editing it never turns a trick off.
//   * a top-level `media/`, `captures/` and `inputs/` folder: pictures the program makes or shows, and the
//     files a later slice hands it. In the approved copy (approved.ts) these three are the writable ones.
//   * any `*.log` file: what a program appends to as it runs.
//   * every dot file and dot folder, and every `node_modules/` folder.
//
// WHAT THE WALK REFUSES, so a trick with it cannot be approved and its row says why in plain words:
//
//   * a symbolic link anywhere the walk looks, a top-level `media/` or `captures/` link included (a linked
//     `node_modules/` or top-level `inputs/` is left out, as those folders are never copied). A link
//     in the approved copy would point somewhere else than it did in the folder (the copy sits deeper),
//     or at the live folder itself, so code nobody approved could run. `collie trick add` refuses links
//     for the same reason (cli/trick-add.ts).
//   * a name with a character that does not show as itself ({@link unsafeText}: a control, a direction
//     mark, a line separator, a zero-width joiner, a blank-looking letter): the card could not show it.
//
// PICTURES ARE NOT CODE, AND NOTHING ELSE IN `media/` OR `captures/` IS COPIED. The approved copy
// (approved.ts) brings in from those two folders only a file whose name ends in `.png`, `.jpg`, `.jpeg` or
// `.webp` ({@link isPictureName}) and whose first bytes say it is a PNG, JPEG or WebP picture. Anything
// else there stays behind, so a program in the copy can never import a file the hash and the card left
// out. `inputs/` is never copied at all. So the rule an author reads: "media/ and captures/ hold
// pictures; code goes anywhere else in the folder, where it is hashed and shown."
//
// A FIFO, a socket or a device is hashed by its kind and path only and never opened, so it cannot hang
// a scan. More than {@link CODE_FILES_MAX} files or {@link CODE_BYTES_MAX} bytes refuses the trick with
// a reason: a folder that big is a mistake, and hashing it every change would cost the bridge.
//
// The cheap half is the walk: one `lstat` per file, no read. Its fingerprint (path, kind, size, mtime,
// inode and ctime of each entry) tells the scanner when to hash again, so the 2 s scan reads no file while
// nothing moved.

/** The most files hashed. More refuses the trick. */
export const CODE_FILES_MAX = 2000;
/** The most folders walked. More refuses the trick. */
export const CODE_DIRS_MAX = 2000;
/** The most bytes hashed, all files together. More refuses the trick. */
export const CODE_BYTES_MAX = 20 * 1024 * 1024;
/** The settings file beside `trick.toml`, outside the hash. */
export const CONFIG_FILE = "config.toml";
/**
 * Top-level folders outside the hash: the program's pictures (`media/`, `captures/`) and the files a later
 * slice fetches for it (`inputs/`). The approved copy (approved.ts) makes these three writable.
 */
export const WRITABLE_TOP_DIRS = ["media", "captures", "inputs"] as const;
const SKIPPED_TOP_DIRS: ReadonlySet<string> = new Set(WRITABLE_TOP_DIRS);
/** The top-level folders whose pictures, and only those, are copied into the approved copy (approved.ts). */
export const PICTURE_DIRS = ["media", "captures"] as const;
const PICTURE_NAME = /\.(?:png|jpe?g|webp)$/i;

/** Whether a file name is a picture's: `.png`, `.jpg`, `.jpeg` or `.webp`. The copy checks the bytes too. */
export function isPictureName(name: string): boolean {
  return PICTURE_NAME.test(name);
}

/**
 * Whether text holds a character a card could not show as it is: a line break, a tab, or any character
 * web/src/lib/hidden-chars.ts `isHiddenChar` names (a control, a format or direction character, a line
 * separator, a zero-width joiner, a blank-looking letter, a space that is not U+0020; review 7 M1). The
 * phone's `diff` rule runs the same function. A file name with one is refused by the walk, and a code line
 * on a card has each one as a `?` (version-diff.ts `readViewLine`).
 */
export function unsafeText(text: string): boolean {
  for (const ch of text) if (ch === "\n" || ch === "\t" || isHiddenChar(ch)) return true;
  return false;
}

export type EntryKind = "file" | "dir" | "symlink" | "other";

export interface FsStat {
  kind: EntryKind;
  size: number;
  mtimeMs: number;
  ino: number;
  /** The inode change time: unlike mtime, no caller can set it back. Absent from a test's fake. */
  ctimeMs?: number;
  /** The permission bits, for a card that says a file became executable. Absent from a test's fake. */
  mode?: number;
}

/** A folder listing: its entries, or why it could not be listed (`missing` for ENOENT only). */
export type ListResult = { ok: true; entries: { name: string; kind: EntryKind }[] } | { ok: false; missing: boolean; error: string };

/** The file system a scan reads, behind a seam so a test can count reads or make one hang. */
export interface TrickFs {
  list(dir: string): Promise<ListResult>;
  /** The entry itself, never what a symlink names; null when it is not there. */
  lstat(path: string): Promise<FsStat | null>;
  /** At most `max` bytes of a regular file, never through a symlink and never blocking on a FIFO; null when it cannot be read. */
  read(path: string, max: number): Promise<Uint8Array | null>;
  readlink(path: string): Promise<string | null>;
}

function kindOf(entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): EntryKind {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "dir";
  return "other";
}

/** `O_NOFOLLOW` and `O_NONBLOCK` where the platform has them: a symlink is refused and a FIFO never blocks the open. */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

export const diskTrickFs: TrickFs = {
  async list(dir) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return { ok: true, entries: entries.map((e) => ({ name: e.name, kind: kindOf(e) })) };
    } catch (err) {
      const missing = err instanceof Error && "code" in err && err.code === "ENOENT";
      return { ok: false, missing, error: err instanceof Error ? err.message : String(err) };
    }
  },
  async lstat(path) {
    try {
      const st = await lstat(path);
      return { kind: kindOf(st), size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, ctimeMs: st.ctimeMs, mode: st.mode };
    } catch {
      return null;
    }
  },
  async read(path, max) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, READ_FLAGS);
      const st = await handle.stat();
      if (!st.isFile()) return null;
      const want = Math.min(st.size, max);
      const buf = new Uint8Array(want);
      let got = 0;
      // Bounded: each read moves `got` forward or ends the loop; a file that shrank ends early.
      for (let i = 0; got < want && i < 1 + want; i += 1) {
        const { bytesRead } = await handle.read(buf, got, want - got, got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      return got === want ? buf : buf.slice(0, got);
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  },
  async readlink(path) {
    try {
      return await readlink(path);
    } catch {
      return null;
    }
  },
};

/** One entry of the walk: its path relative to the trick folder (with `/`), and what `lstat` said. */
export interface CodeEntry {
  rel: string;
  kind: Exclude<EntryKind, "dir">;
  size: number;
  mtimeMs: number;
  ino: number;
  /** The inode change time, so a file rewritten in place with its mtime put back still moves the listing. */
  ctimeMs?: number;
}

/**
 * The walk: every code entry in path order, or why the trick is refused. `code` names the refusals a
 * caller words on its own: `link` for a symbolic link, `name` for a name the card cannot show.
 */
export type CodeWalk = { ok: true; entries: CodeEntry[] } | { ok: false; reason: string; code?: "link" | "name" };

/** Why the walk refuses a symbolic link. */
export function linkRefusal(rel: string): string {
  return `${rel} is a symbolic link. A trick holds regular files only: put the file itself there.`;
}

/** Whether the walk leaves `name` out, at `depth` 0 for the trick folder's own entries. */
export function skippedName(name: string, kind: EntryKind, depth: number): boolean {
  if (name.startsWith(".")) return true;
  if (kind === "dir") return name === "node_modules" || (depth === 0 && SKIPPED_TOP_DIRS.has(name));
  if (depth === 0 && name === CONFIG_FILE) return true;
  return name.endsWith(".log");
}

/**
 * Whether a regular file at `rel` (relative to a trick folder, `/`-separated) is code: a file the code hash
 * walks, by {@link skippedName} at each step. `config.toml`, `media/`, a `.log`, a dot name, `node_modules/`
 * are not.
 */
export function isCodePath(rel: string): boolean {
  const steps = rel.split("/");
  return steps.every((step, depth) => !skippedName(step, depth === steps.length - 1 ? "file" : "dir", depth));
}

/** Byte order, so the same folder sorts the same on every machine and locale. */
function byPath(a: { rel: string }, b: { rel: string }): number {
  if (a.rel === b.rel) return 0;
  return a.rel < b.rel ? -1 : 1;
}

/** Walk a trick folder: `lstat` only, no symlink followed, capped. */
export async function walkTrickCode(fs: TrickFs, dir: string): Promise<CodeWalk> {
  const entries: CodeEntry[] = [];
  const queue: { rel: string; depth: number }[] = [{ rel: "", depth: 0 }];
  let bytes = 0;
  // Each pass takes one folder off the queue; the caps bound how many can ever be put on it.
  for (let dirs = 0; queue.length > 0; dirs += 1) {
    if (dirs >= CODE_DIRS_MAX) return { ok: false, reason: `The trick folder holds more than ${CODE_DIRS_MAX} folders. Move what is not code out of it.` };
    const next = queue.shift();
    if (next === undefined) break;
    const listed = await fs.list(next.rel === "" ? dir : join(dir, next.rel));
    if (!listed.ok) {
      if (next.rel === "") return { ok: false, reason: `The trick folder cannot be read: ${listed.error}` };
      entries.push({ rel: next.rel, kind: "other", size: 0, mtimeMs: 0, ino: 0 });
      continue;
    }
    for (const item of listed.entries) {
      if (skippedName(item.name, item.kind, next.depth)) continue;
      const rel = next.rel === "" ? item.name : `${next.rel}/${item.name}`;
      if (unsafeText(item.name)) {
        return { ok: false, code: "name", reason: `A file name in the trick folder holds a control or an invisible character (${JSON.stringify(rel).slice(1, -1)}). Rename it.` };
      }
      // A linked `node_modules/` or top-level `inputs/` is never read nor copied, as the folders are not.
      if (item.kind === "symlink" && (item.name === "node_modules" || (next.depth === 0 && item.name === "inputs"))) continue;
      if (item.kind === "symlink") return { ok: false, code: "link", reason: linkRefusal(rel) };
      if (item.kind === "dir") {
        queue.push({ rel, depth: next.depth + 1 });
        continue;
      }
      const st = await fs.lstat(join(dir, rel));
      // Gone between the listing and the stat: the next scan sees the folder as it settled.
      if (st === null || st.kind === "dir") continue;
      if (st.kind === "symlink") return { ok: false, code: "link", reason: linkRefusal(rel) };
      const entry: CodeEntry = { rel, kind: st.kind, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino };
      if (st.ctimeMs !== undefined) entry.ctimeMs = st.ctimeMs;
      entries.push(entry);
      if (entries.length > CODE_FILES_MAX) return { ok: false, reason: `The trick folder holds more than ${CODE_FILES_MAX} files. Move what is not code out of it, or into media/.` };
      if (st.kind === "file") bytes += st.size;
      if (bytes > CODE_BYTES_MAX) return { ok: false, reason: `The trick folder holds more than ${CODE_BYTES_MAX / (1024 * 1024)} MB of code. Move what is not code out of it, or into media/.` };
    }
  }
  return { ok: true, entries: entries.toSorted(byPath) };
}

/**
 * The walk's fingerprint: moves when any code entry is added, removed, resized, touched or replaced, or
 * changed in place with its mtime put back (the ctime moves; security re-review B8).
 */
export function walkFingerprint(entries: readonly CodeEntry[], extra: string): string {
  const h = createHash("sha256");
  for (const e of entries) h.update(`${e.kind}\0${e.rel}\0${String(e.size)}\0${String(e.mtimeMs)}\0${String(e.ino)}\0${String(e.ctimeMs ?? "")}\n`);
  h.update(extra);
  return h.digest("hex");
}

/** The SHA-256 of the code the walk found, read through `fs`. Hex. */
export async function hashCodeEntries(fs: TrickFs, dir: string, entries: readonly CodeEntry[]): Promise<string> {
  const h = createHash("sha256");
  for (const e of entries) {
    h.update(`${e.kind}\0${e.rel}\0`);
    if (e.kind === "file") {
      const bytes = await fs.read(join(dir, e.rel), CODE_BYTES_MAX);
      if (bytes === null) h.update("unreadable\0");
      else {
        h.update(`${String(bytes.length)}\0`);
        h.update(bytes);
      }
    }
    if (e.kind === "symlink") h.update(`${(await fs.readlink(join(dir, e.rel))) ?? ""}\0`);
    h.update("\n");
  }
  return h.digest("hex");
}

/**
 * The code hash a folder holding exactly `files` (regular files, every one of them code) would have: the
 * format of {@link hashCodeEntries}, from memory. A proposal's new version is approved only when the folder
 * written hashes to this (crew slice 8); a test holds the two equal.
 */
export function codeHashOfFiles(files: readonly { rel: string; bytes: Uint8Array }[]): string {
  const h = createHash("sha256");
  for (const file of [...files].toSorted(byPath)) {
    h.update(`file\0${file.rel}\0`);
    h.update(`${String(file.bytes.length)}\0`);
    h.update(file.bytes);
    h.update("\n");
  }
  return h.digest("hex");
}

/**
 * THE EXTRAS OF AN OFFICIAL TRICK (security review N3): the files an add from the official list installs
 * that the code hash leaves out. Only two kinds may be there: `config.toml` at the top and files under a
 * top-level `media/`. Their hash is the code hash's format over those files, with its own first line, so the
 * two can never be equal. The list names it (`extras`, official.ts), the maintainer script takes it with
 * this function, and the add checks it before anything is written. Any other file the code hash leaves out
 * (`captures/`, `inputs/`, a `.log`) refuses the folder: an official trick ships none.
 */
export function officialExtrasHash(files: readonly { rel: string; bytes: Uint8Array }[]): { ok: true; hash: string } | { ok: false; rel: string } {
  const extras = files.filter((file) => !isCodePath(file.rel));
  const other = extras.find((file) => file.rel !== CONFIG_FILE && !file.rel.startsWith("media/"));
  if (other !== undefined) return { ok: false, rel: other.rel };
  const h = createHash("sha256");
  h.update("collie-extras\0v1\n");
  for (const file of [...extras].toSorted(byPath)) {
    h.update(`file\0${file.rel}\0`);
    h.update(`${String(file.bytes.length)}\0`);
    h.update(file.bytes);
    h.update("\n");
  }
  return { ok: true, hash: h.digest("hex") };
}

/** The code hash of a trick folder, read fresh: what `collie trick on` and the switch route store. */
export async function trickCodeHash(dir: string, fs: TrickFs = diskTrickFs): Promise<{ ok: true; hash: string } | { ok: false; reason: string }> {
  const walk = await walkTrickCode(fs, dir);
  if (!walk.ok) return walk;
  return { ok: true, hash: await hashCodeEntries(fs, dir, walk.entries) };
}
