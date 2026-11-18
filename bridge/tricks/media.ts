// A trick's pictures (M94 review 11): the files of a trick's own `media/` folder, served to the phone
// for an `image` node.
//
//   GET /api/tricks/<host>/<id>/media/<file>     → the bytes, or 404 "no such image"
//
// THE SAME HARDENING AS A HILL IMAGE. A trick folder is code the person approved, but its `media/`
// folder is outside the code hash (a program writes its pictures there between runs), so what the
// route serves is checked as strictly as a file an agent names for the hill (bridge/hill/media.ts,
// `readPostedImage`), in this order:
//
//   1. The trick is this bridge's, known, and switched on: a trick never switched on gets nothing served.
//   2. The file is `media/` and a relative path the schema's image `src` rule takes (`isImageSrc`): no
//      `.` or `..` step, no hidden name, a `.png`, `.jpg`, `.jpeg` or `.webp`, at most 256 characters.
//   3. The path is built under the trick folder's REAL path, and from there on `readPostedImage` holds
//      every check: `lstat` (not a symlink, a regular file, at most 2 MB), its real path is the path as
//      built (so no folder below the trick folder, `media/` included, is a symlink), not under a `.git`
//      folder nor a secret's name, opened with O_NOFOLLOW and O_NONBLOCK, the same inode, the kernel's
//      own name for it, and the leading bytes decide the type: PNG, JPEG or WebP, never SVG, GIF or HTML.
//
// A PICTURE'S VERSION. The bytes of a file can change under one name (a program writes its pictures there),
// and the phone keeps what it fetched for an address, so the bridge names a version for each picture it
// would serve, `WireTrickInfo.media`: the first 12 hex of a sha256 of the bytes. The phone adds it to the
// address (`?v=`) and the route ignores it: the name alone picks the file. {@link TrickMediaVersions} reads
// the bytes of a file once and again only when its size or modified time moves. Pictures stay outside the
// code hash and every approval rule; the version is only a name for the cache.
//
// Every miss is the same 404, so the route tells nothing about what the folder holds. The headers are
// the hill image's (`HILL_MEDIA_HEADERS`: no-store, a sandboxed CSP, inline) plus `nosniff`.

import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, type Dirent } from "node:fs";
import { dirname, join, sep } from "node:path";

import { isImageSrc, TRICK_MEDIA_DIR, TRICK_MEDIA_VERSIONS_MAX, type WireTrickInfo } from "../../web/src/lib/tricks/schema.ts";
import { HILL_MEDIA_BYTES_MAX, type HillMediaMime } from "../../web/src/lib/hill/wire.ts";
import { readPostedImage } from "../hill/media.ts";

/** One picture of a trick, read and checked. */
export interface TrickMediaFile {
  readonly mime: HillMediaMime;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/**
 * The bytes of `rel` in the trick folder `dir`, or null. `rel` must be a path the image `src` rule takes,
 * which starts with `media/`. Total: no input makes it throw.
 */
export function readTrickMedia(dir: string, rel: string): TrickMediaFile | null {
  if (!isImageSrc(rel) || !rel.startsWith(`${TRICK_MEDIA_DIR}/`)) return null;
  let root: string;
  try {
    root = realpathSync(dir);
  } catch {
    return null;
  }
  // `readPostedImage` refuses a path whose real path differs from it, so building on the folder's real
  // path leaves no room for a symlink below it. No denied folders: the trick folder sits inside the
  // config folder by design, and the rule above keeps the read inside its `media/`.
  const read = readPostedImage(join(root, rel), []);
  return read.ok ? { mime: read.mime, bytes: new Uint8Array(read.bytes) } : null;
}

/** How deep below `media/` a picture may sit, and how many directory entries one walk looks at. */
const WALK_DEPTH_MAX = 4;
const WALK_ENTRIES_MAX = 400;

/** The version of picture bytes: the first 12 hex of their sha256. */
export function mediaVersionOfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

/** A trick's picture versions by `src`: `WireTrickInfo.media`. */
export type MediaVersionMap = NonNullable<WireTrickInfo["media"]>;

interface SeenFile {
  readonly mtimeMs: number;
  readonly size: number;
  readonly version: string;
}

/**
 * The versions of the pictures in trick folders, by `src`. A file is read once per (path, modified time,
 * size): a replaced file gets a new version, a file with the same bytes keeps its one. What it lists is what
 * {@link readTrickMedia} would serve: it reads every file through it, so a symlink, a hidden name, a file over
 * 2 MB or a file that is not a PNG, JPEG or WebP is left out. At most {@link TRICK_MEDIA_VERSIONS_MAX}
 * pictures, in name order. Total: no input makes it throw.
 */
export class TrickMediaVersions {
  private readonly seen = new Map<string, Map<string, SeenFile>>();

  /** The `src` to version map of the pictures under `dir`'s `media/`; empty when there are none. */
  of(dir: string): MediaVersionMap {
    const out: MediaVersionMap = {};
    let root: string;
    try {
      root = realpathSync(dir);
    } catch {
      this.seen.delete(dir);
      return out;
    }
    const before = this.seen.get(dir) ?? new Map<string, SeenFile>();
    const now = new Map<string, SeenFile>();
    const budget = { entries: WALK_ENTRIES_MAX };
    for (const rel of walkMedia(root, TRICK_MEDIA_DIR, 0, budget)) {
      if (Object.keys(out).length === TRICK_MEDIA_VERSIONS_MAX) break;
      if (!isImageSrc(rel)) continue;
      const stat = statOf(join(root, rel));
      if (stat === null) continue;
      const known = before.get(rel);
      const kept = known !== undefined && known.mtimeMs === stat.mtimeMs && known.size === stat.size ? known : null;
      const version = kept?.version ?? versionOfFile(root, rel);
      if (version === null) continue;
      now.set(rel, { mtimeMs: stat.mtimeMs, size: stat.size, version });
      out[rel] = version;
    }
    this.seen.set(dir, now);
    return out;
  }

  /** Forget what is held for the folders no longer in `keep`, so a removed trick leaves nothing behind. */
  retain(keep: ReadonlySet<string>): void {
    for (const dir of this.seen.keys()) {
      if (!keep.has(dir)) this.seen.delete(dir);
    }
  }
}

function statOf(path: string): { mtimeMs: number; size: number; executable: boolean } | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > HILL_MEDIA_BYTES_MAX) return null;
    return { mtimeMs: stat.mtimeMs, size: stat.size, executable: (stat.mode & 0o111) !== 0 };
  } catch {
    return null;
  }
}

function versionOfFile(root: string, rel: string): string | null {
  const read = readTrickMedia(root, rel);
  return read === null ? null : mediaVersionOfBytes(read.bytes);
}

/** The relative paths of the regular files under `base`, in name order. Symlinks and hidden names are not followed or listed. */
function walkMedia(root: string, base: string, depth: number, budget: { entries: number }): string[] {
  if (depth > WALK_DEPTH_MAX || budget.entries <= 0) return [];
  let names: Dirent[];
  try {
    names = readdirSync(join(root, base), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of names.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (budget.entries <= 0) break;
    budget.entries -= 1;
    if (entry.name.startsWith(".")) continue;
    const rel = `${base}/${entry.name}`;
    if (entry.isFile()) out.push(rel);
    else if (entry.isDirectory()) out.push(...walkMedia(root, rel, depth + 1, budget));
  }
  return out;
}

interface SyncedFile {
  readonly mtimeMs: number;
  readonly size: number;
  /** The sha256 hex of the source bytes the copy last took (or was found to hold). */
  readonly hash: string;
}

/**
 * A picture changed by hand in the installed trick folder's `media/` reaches the approved copy without a new yes
 * (pictures are not code, as `config.toml` is not). On each call, for each file of the folder's `media/` that
 * {@link readTrickMedia} would serve (a picture by its first bytes and its name, at most 2 MB, no link, no hidden
 * name) and that is not executable, the copy takes its bytes when they differ from what was last synced. It
 * only adds and replaces: a file the copy holds that the folder lacks stays (the program wrote it), nothing is
 * deleted, a link is never followed, and a file the program wrote after the last sync is replaced only when the
 * source changed since. The first look at a file (no record yet, after a restart) copies it when the copy lacks it
 * or when the source is newer than the copy's file, and otherwise only records it. The write is a temp file in the
 * same folder and a rename. `captures/` is not synced: the route serves `media/` only. Total: never throws.
 */
export class TrickMediaSync {
  private readonly synced = new Map<string, Map<string, SyncedFile>>();

  /** Sync one trick; the number of files written to the copy. */
  sync(srcDir: string, copyDir: string): number {
    let srcRoot: string;
    let copyRoot: string;
    try {
      srcRoot = realpathSync(srcDir);
      copyRoot = realpathSync(copyDir);
    } catch {
      return 0;
    }
    const before = this.synced.get(srcDir) ?? new Map<string, SyncedFile>();
    const now = new Map<string, SyncedFile>();
    const budget = { entries: WALK_ENTRIES_MAX };
    let written = 0;
    for (const rel of walkMedia(srcRoot, TRICK_MEDIA_DIR, 0, budget)) {
      if (now.size === TRICK_MEDIA_VERSIONS_MAX) break;
      if (!isImageSrc(rel)) continue;
      const stat = statOf(join(srcRoot, rel));
      if (stat === null || stat.executable) continue;
      const known = before.get(rel);
      if (known !== undefined && known.mtimeMs === stat.mtimeMs && known.size === stat.size) {
        now.set(rel, known);
        continue;
      }
      const read = readTrickMedia(srcRoot, rel);
      if (read === null) continue;
      const hash = createHash("sha256").update(read.bytes).digest("hex");
      const changed = known === undefined ? this.firstLook(copyRoot, rel, hash, stat.mtimeMs) : known.hash !== hash;
      if (changed && !putPicture(copyRoot, rel, read.bytes)) continue;
      if (changed) written += 1;
      now.set(rel, { mtimeMs: stat.mtimeMs, size: stat.size, hash });
    }
    this.synced.set(srcDir, now);
    return written;
  }

  /** Whether a file with no record is copied: the copy lacks it, or holds other bytes and the source is the newer. */
  private firstLook(copyRoot: string, rel: string, hash: string, sourceMtimeMs: number): boolean {
    const held = statOf(join(copyRoot, rel));
    if (held === null) return !isThere(join(copyRoot, rel));
    if (held.mtimeMs >= sourceMtimeMs) return false;
    const bytes = readTrickMedia(copyRoot, rel)?.bytes;
    return bytes === undefined || createHash("sha256").update(bytes).digest("hex") !== hash;
  }

  /** Forget the folders no longer in `keep`. */
  retain(keep: ReadonlySet<string>): void {
    for (const dir of this.synced.keys()) {
      if (!keep.has(dir)) this.synced.delete(dir);
    }
  }
}

/** Whether anything (a link, a folder, a file) is at `path`: a copy's name that is taken by a non-file is never overwritten. */
function isThere(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write `bytes` to `<copyRoot>/<rel>` through a hidden temp file in the same folder and a rename. Refuses a
 * name that is a link or a folder, and a folder below `media/` that is not a real folder under the copy. False when it did not write.
 */
function putPicture(copyRoot: string, rel: string, bytes: Uint8Array): boolean {
  const target = join(copyRoot, rel);
  const folder = dirname(target);
  let temp: string | null = null;
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const real = realpathSync(folder);
    const mediaRoot = join(copyRoot, TRICK_MEDIA_DIR);
    if (real !== folder || !(real === mediaRoot || real.startsWith(`${mediaRoot}${sep}`))) return false;
    try {
      const held = lstatSync(target);
      if (!held.isFile()) return false;
    } catch {
      // Nothing there yet.
    }
    temp = join(folder, `.${randomBytes(6).toString("hex")}.tmp`);
    writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
    renameSync(temp, target);
    return true;
  } catch {
    if (temp !== null) rmSync(temp, { force: true });
    return false;
  }
}
