import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

// THE CODE OF A TRICK, AS ONE HASH (M94): what a person approves when they switch a trick on.
//
// The switch stores this hash (switches.ts), and a trick runs only while its folder still hashes the
// same. So an edited program, a swapped `run` line or a new helper file stops the trick until a person
// switches it on again. The hash is a SHA-256 over every file of the folder that is code: the sorted
// relative paths, each with its kind and its bytes. Not code, so never hashed:
//
//   * `config.toml` at the top: the person's settings for the program. Editing it never turns a trick off.
//   * a top-level `media/` and `captures/` folder: pictures the program makes or shows.
//   * any `*.log` file: what a program appends to as it runs.
//   * every dot file and dot folder, and every `node_modules/` folder.
//
// A symlink is never followed: its target string is hashed, so pointing it elsewhere changes the hash.
// A FIFO, a socket or a device is hashed by its kind and path only and never opened, so it cannot hang
// a scan. More than {@link CODE_FILES_MAX} files or {@link CODE_BYTES_MAX} bytes refuses the trick with
// a reason: a folder that big is a mistake, and hashing it every change would cost the bridge.
//
// The cheap half is the walk: one `lstat` per file, no read. Its fingerprint (path, kind, size, mtime
// and inode of each entry) tells the scanner when to hash again, so the 2 s scan reads no file while
// nothing moved.

/** The most files hashed. More refuses the trick. */
export const CODE_FILES_MAX = 2000;
/** The most folders walked. More refuses the trick. */
export const CODE_DIRS_MAX = 2000;
/** The most bytes hashed, all files together. More refuses the trick. */
export const CODE_BYTES_MAX = 20 * 1024 * 1024;
/** The settings file beside `trick.toml`, outside the hash. */
export const CONFIG_FILE = "config.toml";
/** Top-level folders outside the hash. */
const SKIPPED_TOP_DIRS = new Set(["media", "captures"]);

export type EntryKind = "file" | "dir" | "symlink" | "other";

export interface FsStat {
  kind: EntryKind;
  size: number;
  mtimeMs: number;
  ino: number;
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
      return { kind: kindOf(st), size: st.size, mtimeMs: st.mtimeMs, ino: st.ino };
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
}

/** The walk: every code entry in path order, or why the trick is refused. */
export type CodeWalk = { ok: true; entries: CodeEntry[] } | { ok: false; reason: string };

/** Whether the walk leaves `name` out, at `depth` 0 for the trick folder's own entries. */
export function skippedName(name: string, kind: EntryKind, depth: number): boolean {
  if (name.startsWith(".")) return true;
  if (kind === "dir") return name === "node_modules" || (depth === 0 && SKIPPED_TOP_DIRS.has(name));
  if (depth === 0 && name === CONFIG_FILE) return true;
  return name.endsWith(".log");
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
      if (item.kind === "dir") {
        queue.push({ rel, depth: next.depth + 1 });
        continue;
      }
      const st = await fs.lstat(join(dir, rel));
      // Gone between the listing and the stat: the next scan sees the folder as it settled.
      if (st === null || st.kind === "dir") continue;
      entries.push({ rel, kind: st.kind, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino });
      if (entries.length > CODE_FILES_MAX) return { ok: false, reason: `The trick folder holds more than ${CODE_FILES_MAX} files. Move what is not code out of it, or into media/.` };
      if (st.kind === "file") bytes += st.size;
      if (bytes > CODE_BYTES_MAX) return { ok: false, reason: `The trick folder holds more than ${CODE_BYTES_MAX / (1024 * 1024)} MB of code. Move what is not code out of it, or into media/.` };
    }
  }
  return { ok: true, entries: entries.toSorted(byPath) };
}

/** The walk's fingerprint: moves when any code entry is added, removed, resized, touched or replaced. */
export function walkFingerprint(entries: readonly CodeEntry[], extra: string): string {
  const h = createHash("sha256");
  for (const e of entries) h.update(`${e.kind}\0${e.rel}\0${String(e.size)}\0${String(e.mtimeMs)}\0${String(e.ino)}\n`);
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

/** The code hash of a trick folder, read fresh: what `collie trick on` and the switch route store. */
export async function trickCodeHash(dir: string, fs: TrickFs = diskTrickFs): Promise<{ ok: true; hash: string } | { ok: false; reason: string }> {
  const walk = await walkTrickCode(fs, dir);
  if (!walk.ok) return walk;
  return { ok: true, hash: await hashCodeEntries(fs, dir, walk.entries) };
}
