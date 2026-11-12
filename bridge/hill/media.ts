// The images of the hill (M96): a file an agent names on its own machine, read by the bridge, kept
// under the bridge's own name, and served back to the phone.
//
//   <stateDir>/hill/media/<decision id>/<media id>      folder 0700, file 0600
//
// WHY THE BRIDGE READS THE FILE. The walky socket's request line is capped at 64 KiB, so the bytes of
// a screenshot cannot ride in the post. The CLI sends an absolute path instead, and the bridge, which
// runs as the same user on the same machine, reads the file itself. An agent can already read every
// file that user can, so the path gives it nothing new; what matters is what the BRIDGE agrees to read
// and later serve to the phone. That is narrow, checked in this order ({@link readPostedImage}):
//
//   1. The path is absolute and normal (no `.` or `..`, no NUL), at most 4096 characters.
//   2. `lstat`: it exists, it is not a symlink, not a folder, and it is a regular file (no FIFO, no
//      device, no socket), at most {@link HILL_MEDIA_BYTES_MAX} bytes.
//   3. Its real path is the path as given: no folder on the way is a symlink either.
//   4. It is not inside the bridge's own state folder or config folder, not under a `.git` folder,
//      and its name is not one of a state folder's secrets (`isDeniedPath`, the Files view's rule).
//      One exception, for a trick's post only (M94): see "A TRICK'S OWN FOLDER" below.
//   5. It is opened with O_NOFOLLOW (a symlink swapped in after the `lstat` fails the open) and
//      O_NONBLOCK (a FIFO swapped in cannot hang the bridge). The open handle must be a regular file,
//      the same device and inode the `lstat` saw, and on Linux the kernel's own name for it
//      (`/proc/self/fd/<fd>`) must be the path as given. Then at most the cap plus one byte is read.
//   6. The leading bytes decide the type: PNG, JPEG or WebP. Nothing else is kept, whatever the name
//      or a claimed type says: no SVG (it is text and can carry script), no GIF, no HTML.
//
// A hard link to a file elsewhere passes, as in the Files view: it is the same inode under a name the
// agent made, which needs write access there, and the agent can read that file anyway.
//
// A TRICK'S OWN FOLDER (M94). A trick lives in `<configDir>/tricks/<id>/`, inside the config folder,
// and its decisions name images in that folder. The tricks runner passes that folder's real path as
// `root` ({@link HillImageRoot}); the service passes it on for a post whose sender is a trick, and
// never for an agent's (the socket's sender type has no such field). With a root, and a real path
// strictly below it, a denied folder that holds the root strictly above it (the config folder, in
// practice) does not deny that one path. Nothing else moves: every other denied folder, the `.git`
// rule, the secret names, and every check before and after (absolute and normal, no symlink, same
// inode, the cap, the leading bytes) hold as for any post. A root inside the state folder or the
// media folder (`never`) lifts nothing, and so does a root that IS a denied folder, so a root wider
// than one trick's folder gains nothing. A real path has no symlink on the way, so a path below the
// root in text is below it on disk: `../` out of the folder fails check 1, and a symlink in the
// folder that points out fails check 2 or 3.
//
// THE NAME ON DISK IS NEVER THE POSTER'S. A decision's folder is its id (`dc_` and 12 characters) and
// a file is its media id (`im_` and 16 characters), both minted by the bridge and checked against
// their patterns before any path is built, on the way in and on the way out.
//
// NOTHING IS DECODED OR RE-ENCODED. Width and height come off the header when it is cheap to read
// (PNG's IHDR, a JPEG start-of-frame marker, the three WebP chunk kinds), else they are null.

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";

import { HILL_ID_RE, HILL_IMAGE_PATH_MAX, HILL_MEDIA_BYTES_MAX, HILL_MEDIA_ID_RE, HILL_MEDIA_MIMES, type HillMedia, type HillMediaMime } from "../../web/src/lib/hill/wire.ts";
import { isDeniedPath, sniffImageType } from "../files-view.ts";
import { HOST, isBelow } from "../host.ts";
import { headerField } from "../walky/types.ts";

/** The media folder's name inside the hill folder. */
export const MEDIA_DIR = "media";


/** O_NOFOLLOW and O_NONBLOCK exist on POSIX only; elsewhere they read as 0 (the walky socket is POSIX only). */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** One image read and checked, ready to be kept. */
export interface HillImageBytes {
  readonly mime: HillMediaMime;
  readonly bytes: Uint8Array;
  readonly width: number | null;
  readonly height: number | null;
}

/** What reading a posted image comes to: the bytes, or the refusal with its code and plain words. */
export type HillImageRead = ({ readonly ok: true } & HillImageBytes) | { readonly ok: false; readonly code: "bad_image" | "image_too_large"; readonly error: string };

/** Mint a media id: `im_` and 16 characters of [a-z0-9], from a uniform random source. */
export function mintMediaId(random: (n: number) => Uint8Array = (n) => randomBytes(n)): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  // 252 is the largest multiple of 36 below 256: a byte at or above it is skipped, so no letter is likelier.
  while (out.length < 16) {
    for (const byte of random(24)) {
      if (byte >= 252) continue;
      out += alphabet[byte % 36];
      if (out.length === 16) break;
    }
  }
  return `im_${out}`;
}

function ascii(b: Uint8Array, at: number, text: string): boolean {
  if (b.length < at + text.length) return false;
  for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false;
  return true;
}

function u16be(b: Uint8Array, at: number): number {
  return (b[at]! << 8) | b[at + 1]!;
}

function u16le(b: Uint8Array, at: number): number {
  return b[at]! | (b[at + 1]! << 8);
}

function u32be(b: Uint8Array, at: number): number {
  return ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
}

function u24le(b: Uint8Array, at: number): number {
  return b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
}

/** The type of an image the hill keeps, off its leading bytes only. Null for every other file, GIF and SVG included. */
export function hillImageMime(head: Uint8Array): HillMediaMime | null {
  const type = sniffImageType(head);
  return HILL_MEDIA_MIMES.find((mime) => mime === type) ?? null;
}

function sized(width: number, height: number): { width: number; height: number } | null {
  return width > 0 && height > 0 ? { width, height } : null;
}

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let at = 2;
  // Every step moves `at` forward by at least one byte, so the loop ends within the buffer.
  while (at + 9 <= b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1]!;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = u16be(b, at + 2);
    if (length < 2) return null;
    // SOF0 to SOF15, without DHT (C4), JPG (C8) and DAC (CC), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return sized(u16be(b, at + 7), u16be(b, at + 5));
    at += 2 + length;
  }
  return null;
}

function webpSize(b: Uint8Array): { width: number; height: number } | null {
  if (ascii(b, 12, "VP8 ") && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return sized(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  if (ascii(b, 12, "VP8L") && b.length >= 25 && b[20] === 0x2f) {
    const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
    return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (ascii(b, 12, "VP8X") && b.length >= 30) return sized(u24le(b, 24) + 1, u24le(b, 27) + 1);
  return null;
}

/** Width and height off the image's header, when it is cheap to read. Null when it is not there. */
export function hillImageSize(bytes: Uint8Array, mime: HillMediaMime): { width: number; height: number } | null {
  switch (mime) {
    case "image/png":
      return ascii(bytes, 12, "IHDR") && bytes.length >= 24 ? sized(u32be(bytes, 16), u32be(bytes, 20)) : null;
    case "image/jpeg":
      return jpegSize(bytes);
    case "image/webp":
      return webpSize(bytes);
  }
}

const TOO_LARGE = `an image is at most ${String(HILL_MEDIA_BYTES_MAX / (1024 * 1024))} MB`;

function bad(path: string, why: string): HillImageRead {
  return { ok: false, code: "bad_image", error: `${headerField(path, 120)}: ${why}` };
}

function tooLarge(path: string): HillImageRead {
  return { ok: false, code: "image_too_large", error: `${headerField(path, 120)}: ${TOO_LARGE}` };
}

/** The kernel's own name for an open descriptor on Linux, or null elsewhere (and when it cannot be read). */
function kernelPathOf(fd: number): string | null {
  if (HOST.platform !== "linux") return null;
  try {
    return readlinkSync(`/proc/self/fd/${String(fd)}`);
  } catch {
    return null;
  }
}

/** Read `want` bytes at most from the start of an open file. */
function readUpTo(fd: number, want: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(want);
  let got = 0;
  while (got < want) {
    const n = readSync(fd, bytes, got, want - got, got);
    if (n === 0) break;
    got += n;
  }
  return bytes.subarray(0, got);
}

/** A trick's own folder, the one place inside a denied folder a trick's post may name (this file's header). */
export interface HillImageRoot {
  /** The trick folder's real path: absolute, normal, no symlink on the way. */
  readonly root: string;
  /** Folders a root inside lifts nothing: the state folder and the media folder, each as given and as its real path. */
  readonly never: readonly string[];
}

/**
 * The denied folders for one real path. With a trick's root and a path strictly below it, a denied
 * folder that holds the root strictly above it is left out; every other folder stays. A root off its
 * rule, or inside a `never` folder, leaves the list as it is.
 */
function deniedFor(real: string, denied: readonly string[], allowed: HillImageRoot | null): readonly string[] {
  if (allowed === null) return denied;
  const { root, never } = allowed;
  if (!isAbsolute(root) || normalize(root) !== root || !isBelow(HOST, root, real)) return denied;
  if (never.some((folder) => folder.trim() !== "" && isBelow(HOST, folder, root)) || never.includes(root)) return denied;
  return denied.filter((folder) => !isBelow(HOST, folder, root));
}

/**
 * One image a post names, read by the checks in this file's header, in that order. `denied` is the
 * list {@link deniedFoldersSync} makes of the bridge's own folders; `allowed` a trick's own folder, for
 * a trick's post only. Total: no input makes it throw.
 */
export function readPostedImage(path: string, denied: readonly string[], allowed: HillImageRoot | null = null): HillImageRead {
  if (path === "" || path.length > HILL_IMAGE_PATH_MAX || path.includes("\0")) return bad(path, "an image is named by an absolute path");
  if (!isAbsolute(path) || normalize(path) !== path || path.endsWith("/")) return bad(path, "an image is named by an absolute path with no . or .. in it");
  let link: ReturnType<typeof lstatSync>;
  try {
    link = lstatSync(path);
  } catch {
    return bad(path, "no such file, or the bridge may not read it");
  }
  if (link.isSymbolicLink()) return bad(path, "is a symlink; name the file itself");
  if (link.isDirectory()) return bad(path, "is a folder, not an image");
  if (!link.isFile()) return bad(path, "is not a regular file");
  if (link.size > HILL_MEDIA_BYTES_MAX) return tooLarge(path);
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return bad(path, "the bridge may not read it");
  }
  if (real !== path) return bad(path, "goes through a symlinked folder; name the real path");
  if (isDeniedPath(real, deniedFor(real, denied, allowed))) return bad(path, "is inside Collie's own folders, a .git folder, or names a Collie secret");
  let fd: number;
  try {
    fd = openSync(path, OPEN_FLAGS);
  } catch {
    return bad(path, "could not be opened");
  }
  let bytes: Uint8Array;
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) return bad(path, "is not a regular file");
    if (opened.dev !== link.dev || opened.ino !== link.ino) return bad(path, "changed while it was read");
    const kernel = kernelPathOf(fd);
    if (HOST.platform === "linux" && kernel !== path) return bad(path, "changed while it was read");
    if (opened.size > HILL_MEDIA_BYTES_MAX) return tooLarge(path);
    bytes = readUpTo(fd, HILL_MEDIA_BYTES_MAX + 1);
  } catch {
    return bad(path, "could not be read");
  } finally {
    closeSync(fd);
  }
  if (bytes.length > HILL_MEDIA_BYTES_MAX) return tooLarge(path);
  const mime = hillImageMime(bytes);
  if (mime === null) return bad(path, "is not a PNG, JPEG or WebP image (read from its first bytes, not its name)");
  const size = hillImageSize(bytes, mime);
  return { ok: true, mime, bytes, width: size?.width ?? null, height: size?.height ?? null };
}

/** Each private folder as given and as its real path, whichever spelling a path reaches. */
export function deniedFoldersSync(privateFolders: readonly string[]): string[] {
  const denied: string[] = [];
  for (const folder of privateFolders) {
    if (folder.trim() === "") continue;
    denied.push(folder);
    try {
      const real = realpathSync(folder);
      if (real !== folder) denied.push(real);
    } catch {
      // A folder that does not exist yet still denies its spelling.
    }
  }
  return denied;
}

/** One image to keep, under the id the bridge minted for it. */
export interface HillMediaFile {
  readonly id: string;
  readonly bytes: Uint8Array;
}

/**
 * The media folder: what the service keeps and what the route serves. One writer, synchronous, like
 * the decisions file: a post reads, saves and stores with no await in between.
 */
export class HillMediaStore {
  private readonly root: string;
  /** The state folder (the hill folder's parent) and the media folder: a trick's root inside them lifts nothing. */
  private readonly never: readonly string[];

  /** `dir` is the hill folder (`hillDir(stateDir)`); `denied` the bridge's own folders, as {@link deniedFoldersSync} lists them. */
  constructor(
    dir: string,
    private readonly denied: readonly string[],
    private readonly warn: (line: string) => void = (line) => console.warn(line),
  ) {
    this.root = join(dir, MEDIA_DIR);
    this.never = deniedFoldersSync([dirname(dir), this.root]);
  }

  /**
   * Read and check one image a post names. `trickRoot` is a trick's own folder, from the tricks runner
   * through a trick sender only (this file's header); an agent's post never has one.
   */
  read(path: string, trickRoot: string | null = null): HillImageRead {
    return readPostedImage(path, [...this.denied, this.root], trickRoot === null ? null : { root: trickRoot, never: this.never });
  }

  /** Keep a decision's images, each whole or none at all. False when any write failed; then nothing is left behind. */
  save(decisionId: string, files: readonly HillMediaFile[]): boolean {
    if (!HILL_ID_RE.test(decisionId) || files.some((file) => !HILL_MEDIA_ID_RE.test(file.id))) return false;
    const folder = join(this.root, decisionId);
    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      chmodSync(this.root, 0o700);
      rmSync(folder, { recursive: true, force: true });
      mkdirSync(folder, { mode: 0o700 });
      chmodSync(folder, 0o700);
      for (const file of files) {
        const target = join(folder, file.id);
        const temp = `${target}.tmp`;
        writeFileSync(temp, file.bytes, { mode: 0o600, flag: "wx" });
        chmodSync(temp, 0o600);
        renameSync(temp, target);
      }
      return true;
    } catch (err) {
      this.warn(`[hill] could not keep the images of ${decisionId}: ${err instanceof Error ? err.message : String(err)}`);
      this.remove(decisionId);
      return false;
    }
  }

  /**
   * The bytes of one kept image, or null. Both ids are checked before a path is built; the file is
   * opened without following a link, must be a regular file of the size and the type the decision
   * recorded, and is read whole (at most the cap).
   */
  bytesOf(decisionId: string, media: Pick<HillMedia, "id" | "mime" | "bytes">): Uint8Array<ArrayBuffer> | null {
    if (!HILL_ID_RE.test(decisionId) || !HILL_MEDIA_ID_RE.test(media.id)) return null;
    let fd: number;
    try {
      fd = openSync(join(this.root, decisionId, media.id), OPEN_FLAGS);
    } catch {
      return null;
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size !== media.bytes || st.size > HILL_MEDIA_BYTES_MAX) return null;
      const bytes = readUpTo(fd, st.size);
      return bytes.length === media.bytes && hillImageMime(bytes) === media.mime ? bytes : null;
    } catch {
      return null;
    } finally {
      closeSync(fd);
    }
  }

  /** Remove one decision's images. */
  remove(decisionId: string): void {
    if (!HILL_ID_RE.test(decisionId)) return;
    try {
      rmSync(join(this.root, decisionId), { recursive: true, force: true });
    } catch (err) {
      this.warn(`[hill] could not remove the images of ${decisionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Remove every folder under the media folder whose decision is not in `held`. Answers how many went. */
  prune(held: ReadonlySet<string>): number {
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      if (held.has(name)) continue;
      try {
        rmSync(join(this.root, name), { recursive: true, force: true });
        removed += 1;
      } catch (err) {
        this.warn(`[hill] could not remove ${name} from the media folder: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return removed;
  }
}
