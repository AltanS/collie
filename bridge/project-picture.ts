// THE PROJECT PICTURE (issue 811, ADR 0161): the `[project] icon` of a session's `collie.toml`
// (bridge/project-file.ts), read off disk, checked, and offered to the phone by version.
//
// ── WHAT A PICTURE MAY BE ────────────────────────────────────────────────────────────────────────
// The path in the file is relative to the folder that holds the file. It is joined onto that folder's
// REAL path and must land strictly below the repository root the file was found in. From there the
// hill's reader holds every disk check (bridge/hill/media.ts, `readPostedImage`): `lstat` (a regular
// file, not a symlink), its real path is the path as built (so no folder on the way is a symlink),
// not under `.git` or the bridge's own folders, opened with O_NOFOLLOW and O_NONBLOCK, the same inode,
// the kernel's own name for it, and the leading bytes decide the type. On top of that, for a project
// picture only ({@link checkProjectPicture}), and without touching the limits of the Hill, tricks or
// Morph:
//
//   - PNG, JPEG or WebP by the first bytes; SVG, GIF, HTML and everything else refused (the hill's rule);
//   - an animated PNG (an `acTL` chunk before the image data) and an animated WebP (the VP8X animation
//     flag, an `ANIM` or an `ANMF` chunk) refused: a picture that moves could imitate a live state;
//   - at most {@link PROJECT_PICTURE_BYTES_MAX} bytes, checked on `lstat` before any read and again on
//     the bytes read;
//   - each side from {@link PROJECT_PICTURE_SIDE_MIN} to {@link PROJECT_PICTURE_SIDE_MAX} px, read from the
//     header without decoding. A header this module cannot read is refused.
//
// ── IT NEVER BLOCKS A POLL ───────────────────────────────────────────────────────────────────────
// The shape of bridge/git-head.ts: {@link ProjectPictures.get} answers from memory and never touches the
// disk, and a missing or stale answer starts a read in the background that the NEXT snapshot carries.
// Three caches, each on its own clock and each re-read only when an `lstat` stamp moved:
//
//   - which file speaks for a folder: walked again every {@link LOCATE_TTL_MS};
//   - what a file says: `lstat` every {@link STAMP_TTL_MS}, read again when its stamp moved;
//   - what a picture is: `lstat` every {@link STAMP_TTL_MS}, read and hashed again when its stamp moved.
//
// So a version changes at most once per {@link STAMP_TTL_MS}, never faster than the poll, however often an
// agent rewrites its picture. Many folders of one repository share one file read and one picture read.
// The folder table is bounded ({@link FOLDERS_MAX}); a folder nobody asked about for {@link FORGET_MS} is
// dropped with every file and picture no remaining folder points at. There is no watcher.
//
// ── THE ROUTE SERVES ONLY WHAT THIS MODULE RESOLVED ──────────────────────────────────────────────
// {@link ProjectPictures.bytesOf} takes a version and looks it up among the pictures this cache holds
// now. The client never names a path. The file is read again through every check above and served only
// when its bytes still hash to the version asked for; a picture that changed since answers nothing,
// and the next snapshot names its new version.

import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";

import { HILL_MEDIA_BYTES_MAX, type HillMediaMime } from "../web/src/lib/hill/wire.ts";
import { PROJECT_PICTURE_BYTES_MAX, PROJECT_PICTURE_SIDE_MAX, PROJECT_PICTURE_SIDE_MIN, isPictureVersion } from "../web/src/lib/project-picture-wire.ts";
import { hillImageSize, readPostedImage } from "./hill/media.ts";
import { HOST, isBelow } from "./host.ts";
import { locateProjectFile, readProjectFile, stampOf, type LocatedProjectFile, type ProjectFileOnDisk } from "./project-file.ts";

/** How long the answer to "which file speaks for this folder" stands. */
export const LOCATE_TTL_MS = 30_000;
/** How long a file's or a picture's `lstat` stamp stands before it is taken again. */
export const STAMP_TTL_MS = 5_000;
/** A folder no snapshot asked about for this long is forgotten. */
export const FORGET_MS = 5 * 60_000;
/** The most folders the cache keeps; past it, the one asked about longest ago goes first. */
export const FOLDERS_MAX = 512;

/** One picture read and checked: its type, its bytes, its version. */
export interface ProjectPictureFile {
  readonly mime: HillMediaMime;
  readonly bytes: Uint8Array;
  readonly version: string;
}

/** What checking a picture comes to. */
export type ProjectPictureRead = ({ readonly ok: true } & ProjectPictureFile) | { readonly ok: false; readonly why: string };

function ascii(b: Uint8Array, at: number, text: string): boolean {
  if (b.length < at + text.length) return false;
  for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false;
  return true;
}

function u32be(b: Uint8Array, at: number): number {
  return ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
}

function u32le(b: Uint8Array, at: number): number {
  return (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
}

/**
 * Whether a PNG moves, or `null` when its chunks cannot be walked to the image data. An `acTL` chunk
 * must come before the first `IDAT` (the APNG rule), so the walk stops there.
 */
export function pngAnimated(b: Uint8Array): boolean | null {
  let at = 8;
  while (at + 8 <= b.length) {
    const length = u32be(b, at);
    if (ascii(b, at + 4, "acTL")) return true;
    if (ascii(b, at + 4, "IDAT")) return false;
    const next = at + 12 + length;
    if (next <= at || next > b.length) return null;
    at = next;
  }
  return null;
}

/**
 * Whether a WebP moves, or `null` when its RIFF chunks cannot be walked. The VP8X header's animation flag
 * (bit 1 of its first byte), an `ANIM` chunk and an `ANMF` chunk each mean it moves.
 */
export function webpAnimated(b: Uint8Array): boolean | null {
  if (!ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) return null;
  let at = 12;
  let chunks = 0;
  while (at + 8 <= b.length) {
    if (ascii(b, at, "ANIM") || ascii(b, at, "ANMF")) return true;
    if (ascii(b, at, "VP8X") && b.length > at + 8 && (b[at + 8]! & 0x02) !== 0) return true;
    const size = u32le(b, at + 4);
    const next = at + 8 + size + (size % 2);
    if (next <= at) return null;
    at = next;
    chunks += 1;
  }
  return chunks > 0 ? false : null;
}

/** Whether one side of a picture is in the allowed range. */
function sideFits(side: number): boolean {
  return side >= PROJECT_PICTURE_SIDE_MIN && side <= PROJECT_PICTURE_SIDE_MAX;
}

/** The project picture's own rules over bytes the hill's reader already took (this file's header). */
export function checkProjectPicture(bytes: Uint8Array, mime: HillMediaMime): string | null {
  if (bytes.length > PROJECT_PICTURE_BYTES_MAX) return `is larger than ${String(PROJECT_PICTURE_BYTES_MAX / 1024)} KB`;
  if (mime === "image/png" && pngAnimated(bytes) !== false) return "is an animated or unreadable PNG";
  if (mime === "image/webp" && webpAnimated(bytes) !== false) return "is an animated or unreadable WebP";
  const size = hillImageSize(bytes, mime);
  if (size === null) return "has no size in its header";
  if (!sideFits(size.width) || !sideFits(size.height)) return `is ${String(size.width)} x ${String(size.height)} px; each side must be ${String(PROJECT_PICTURE_SIDE_MIN)} to ${String(PROJECT_PICTURE_SIDE_MAX)} px`;
  return null;
}

/** The version of picture bytes: the first 12 hex of their sha256. */
export function pictureVersion(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

/**
 * The absolute path an `icon` names, or `null` when it would leave the repository. `icon` already passed
 * `checkIconPath` (no `..`, no absolute path, no `.git`); this is the second, independent check on the
 * joined path.
 */
export function iconTarget(located: LocatedProjectFile, icon: string): string | null {
  const target = normalize(join(dirname(located.file), icon));
  if (!isAbsolute(target) || !isBelow(HOST, located.root, target)) return null;
  return target;
}

/**
 * Read and check one picture at an absolute path. `denied` is the bridge's own folders
 * (`deniedFoldersSync`). Total: never throws.
 */
export async function readProjectPicture(path: string, denied: readonly string[]): Promise<ProjectPictureRead> {
  // The size first, on `lstat`, so a 2 GB file costs no read at all. The hill's reader takes up to its
  // own cap; the bytes are checked against ours again below.
  try {
    const s = await lstat(path);
    if (!s.isFile()) return { ok: false, why: "is not a regular file" };
    if (s.size > PROJECT_PICTURE_BYTES_MAX) return { ok: false, why: `is larger than ${String(PROJECT_PICTURE_BYTES_MAX / 1024)} KB` };
  } catch {
    return { ok: false, why: "does not exist or may not be read" };
  }
  const read = readPostedImage(path, denied);
  if (!read.ok) return { ok: false, why: read.error };
  if (read.bytes.length > HILL_MEDIA_BYTES_MAX) return { ok: false, why: "is too large" };
  const problem = checkProjectPicture(read.bytes, read.mime);
  if (problem !== null) return { ok: false, why: problem };
  return { ok: true, mime: read.mime, bytes: read.bytes, version: pictureVersion(read.bytes) };
}

interface FolderEntry {
  located: LocatedProjectFile | null;
  locatedAt: number;
  askedAt: number;
}

interface FileEntry {
  stamp: string | null;
  checkedAt: number;
  read: ProjectFileOnDisk;
  /** The picture the file names, as an absolute path, or `null`. */
  picture: string | null;
}

interface PictureEntry {
  stamp: string | null;
  checkedAt: number;
  version: string | null;
  mime: HillMediaMime | null;
  why: string | null;
}

/** What server.ts reads at serialise time. */
export interface ProjectPictureSurface {
  /** The picture version for a pane's folder, from memory, or `undefined`. */
  get(folder: string): string | undefined;
}

/** What the route reads. */
export interface ProjectPictureSource {
  bytesOf(version: string): Promise<{ mime: HillMediaMime; bytes: Uint8Array } | null>;
}

/** What `collie doctor` prints about one folder's project file. Names and short reasons only. */
export interface ProjectFileReport {
  readonly file: string | null;
  readonly problem: string | null;
  readonly ignored: readonly string[];
  readonly refused: readonly string[];
  readonly icon: { readonly path: string; readonly ok: boolean; readonly why: string | null } | null;
}

/**
 * Every pane folder's project picture, from memory, kept fresh in the background. ONE object for the
 * whole bridge, like `GitHeads`. `enabled` false is the operator's switch (`COLLIE_PROJECT_FILES=0`):
 * then nothing is read and nothing is served.
 */
export class ProjectPictures implements ProjectPictureSurface, ProjectPictureSource {
  private readonly folders = new Map<string, FolderEntry>();
  private readonly files = new Map<string, FileEntry>();
  private readonly pictures = new Map<string, PictureEntry>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly enabled: boolean,
    private readonly denied: readonly string[],
    private readonly now: () => number = Date.now,
  ) {}

  get(folder: string): string | undefined {
    if (!this.enabled || !isAbsolute(folder)) return undefined;
    const at = this.now();
    const entry = this.folders.get(folder);
    if (entry !== undefined) entry.askedAt = at;
    if (this.stale(folder, at)) void this.settle(folder);
    return this.versionOf(entry);
  }

  /** Bring every folder up to date and forget the ones nobody asked about. Never throws. */
  async refresh(folders: readonly string[]): Promise<void> {
    if (!this.enabled) return;
    const at = this.now();
    this.forget(at);
    const pending: Promise<void>[] = [];
    for (const folder of new Set(folders)) {
      if (!isAbsolute(folder)) continue;
      const entry = this.folders.get(folder);
      if (entry !== undefined) entry.askedAt = at;
      if (this.stale(folder, at)) pending.push(this.settle(folder));
    }
    await Promise.all(pending);
  }

  async bytesOf(version: string): Promise<{ mime: HillMediaMime; bytes: Uint8Array } | null> {
    if (!this.enabled || !isPictureVersion(version)) return null;
    for (const [path, entry] of this.pictures) {
      if (entry.version !== version) continue;
      const read = await readProjectPicture(path, this.denied);
      if (read.ok && read.version === version) return { mime: read.mime, bytes: read.bytes };
    }
    return null;
  }

  /** The project file for one folder, read now and in full, for `collie doctor`. Never throws. */
  async report(folder: string): Promise<ProjectFileReport> {
    const located = await locateProjectFile(folder);
    if (located === null) return { file: null, problem: null, ignored: [], refused: [], icon: null };
    const read = await readProjectFile(located.file);
    const icon = read.settings.icon;
    if (icon === undefined) return { file: located.file, problem: read.problem, ignored: read.ignored, refused: read.refused, icon: null };
    const target = iconTarget(located, icon);
    if (target === null) return { file: located.file, problem: read.problem, ignored: read.ignored, refused: read.refused, icon: { path: icon, ok: false, why: "leaves the repository" } };
    const picture = await readProjectPicture(target, this.denied);
    return { file: located.file, problem: read.problem, ignored: read.ignored, refused: read.refused, icon: { path: icon, ok: picture.ok, why: picture.ok ? null : picture.why } };
  }

  private versionOf(entry: FolderEntry | undefined): string | undefined {
    if (entry?.located === null || entry === undefined) return undefined;
    const file = this.files.get(entry.located.file);
    if (file?.picture === null || file === undefined) return undefined;
    return this.pictures.get(file.picture)?.version ?? undefined;
  }

  private stale(folder: string, at: number): boolean {
    const entry = this.folders.get(folder);
    if (entry === undefined || at - entry.locatedAt >= LOCATE_TTL_MS) return true;
    if (entry.located === null) return false;
    const file = this.files.get(entry.located.file);
    if (file === undefined || at - file.checkedAt >= STAMP_TTL_MS) return true;
    if (file.picture === null) return false;
    const picture = this.pictures.get(file.picture);
    return picture === undefined || at - picture.checkedAt >= STAMP_TTL_MS;
  }

  private settle(folder: string): Promise<void> {
    const running = this.inFlight.get(folder);
    if (running !== undefined) return running;
    const work = this.read(folder)
      .catch(() => undefined)
      .finally(() => this.inFlight.delete(folder));
    this.inFlight.set(folder, work);
    return work;
  }

  private async read(folder: string): Promise<void> {
    let entry = this.folders.get(folder);
    if (entry === undefined || this.now() - entry.locatedAt >= LOCATE_TTL_MS) {
      const located = await locateProjectFile(folder);
      entry = { located, locatedAt: this.now(), askedAt: entry?.askedAt ?? this.now() };
      this.folders.set(folder, entry);
      this.bound();
    }
    if (entry.located === null) return;
    const file = await this.fileOf(entry.located);
    if (file.picture !== null) await this.pictureOf(file.picture);
  }

  private async fileOf(located: LocatedProjectFile): Promise<FileEntry> {
    const cached = this.files.get(located.file);
    if (cached !== undefined && this.now() - cached.checkedAt < STAMP_TTL_MS) return cached;
    const stamp = await stampOf(located.file);
    if (cached !== undefined && stamp !== null && stamp === cached.stamp) {
      cached.checkedAt = this.now();
      return cached;
    }
    const read = await readProjectFile(located.file);
    const icon = read.settings.icon;
    const picture = icon === undefined ? null : iconTarget(located, icon);
    const entry: FileEntry = { stamp: read.stamp, checkedAt: this.now(), read, picture };
    this.files.set(located.file, entry);
    return entry;
  }

  private async pictureOf(path: string): Promise<void> {
    const cached = this.pictures.get(path);
    if (cached !== undefined && this.now() - cached.checkedAt < STAMP_TTL_MS) return;
    const stamp = await stampOf(path);
    if (cached !== undefined && stamp !== null && stamp === cached.stamp) {
      cached.checkedAt = this.now();
      return;
    }
    const read = await readProjectPicture(path, this.denied);
    this.pictures.set(path, read.ok ? { stamp, checkedAt: this.now(), version: read.version, mime: read.mime, why: null } : { stamp, checkedAt: this.now(), version: null, mime: null, why: read.why });
  }

  /** Past {@link FOLDERS_MAX}, drop the folders asked about longest ago. */
  private bound(): void {
    if (this.folders.size <= FOLDERS_MAX) return;
    const oldest = [...this.folders.entries()].toSorted((a, b) => a[1].askedAt - b[1].askedAt);
    for (const [folder] of oldest.slice(0, this.folders.size - FOLDERS_MAX)) this.folders.delete(folder);
    this.sweep();
  }

  private forget(at: number): void {
    for (const [folder, entry] of this.folders) if (at - entry.askedAt >= FORGET_MS) this.folders.delete(folder);
    this.sweep();
  }

  /** Drop every file and picture no remaining folder points at. */
  private sweep(): void {
    const files = new Set<string>();
    for (const entry of this.folders.values()) if (entry.located !== null) files.add(entry.located.file);
    for (const file of this.files.keys()) if (!files.has(file)) this.files.delete(file);
    const pictures = new Set<string>();
    for (const entry of this.files.values()) if (entry.picture !== null) pictures.add(entry.picture);
    for (const picture of this.pictures.keys()) if (!pictures.has(picture)) this.pictures.delete(picture);
  }
}
