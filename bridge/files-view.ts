// THE FILES VIEW'S BRIDGE HALF — one folder listed, or one text file read, under the Changes root
// (ADR 0083), or one picture read as bytes (ADR 0090, {@link readImage}). Read-only by construction: nothing here writes, renames, creates or deletes. The one
// child process is `git check-ignore`, once per listing, through Changes' hardened runner, with the
// names on stdin and no flags at all when git does not answer ({@link gitIgnoredNames}). A third
// call only asks whether paths exist, for the links in the pane view (ADR 0088): the same checks as
// a read, then one `lstat` per path, and nothing opened ({@link existingPaths}).
//
// ── THE THIRD PLACE A CLIENT VALUE BECOMES A PATH ───────────────────────────────────────────────
// The law in bridge/journal/files.ts names three places, and this is the third. Its bound:
//
//   1. The ROOT is never the client's. It is the folder bridge/changes-root.ts picks off the live
//      snapshot for the pane's workspace (the mux's folder, else the panes' common folder), or the
//      asking pane's own cwd when that passes the same `withinBound`. The root's REAL path must pass
//      `withinBound` too, against home's real path, so a workspace folder that is a symlink to `/` or
//      to home is `no-folder` and not the whole disk.
//   2. The client names a path RELATIVE to that root, and it is refused on its shape before any disk
//      call ({@link parseRelPath}): absolute, a `..` or `.` segment, an empty segment, NUL, a
//      backslash, more than 4096 bytes; on Windows also a colon, a wildcard, a trailing dot or space,
//      and a reserved device name.
//   3. The real path of the target must lie inside the real path of the root, through
//      `containedRealpath` (the shared one, host-aware). A symlink that leads out is refused on read
//      and still listed as `link`.
//   4. Denied for list and read alike, and hidden from listings: a `.git` segment, anything inside
//      the bridge's own state folder or config folder, and a file whose basename is a state secret's
//      (`crew-trust.json`, `paired-devices.json`, ..., `isStateSecretName` in bridge/acl-policy.ts),
//      wherever it sits, because a root can hold a SIBLING instance's state folder. All are checked on
//      the requested segments AND on the real path, and case-folded on every host, so `.GIT`, a
//      Windows `.git.`, a link into the state folder, or a link named `notes` that leads to a
//      sibling's `PAIRED-DEVICES.json` all land on the same refusal. A sibling's config `.env` and
//      every other credential file under the root are NOT covered (ADR 0083).
//
// Every refusal is the same answer, `unknown-path`: absent, outside, denied, a folder read as a file
// and a file listed as a folder cannot be told apart by anything the client sees.
//
// ── THE RACE THIS ACCEPTS ───────────────────────────────────────────────────────────────────────
// Between the containment check and the read, a path component can be swapped for a symlink. The
// final component is opened with O_NOFOLLOW (POSIX) so a swap of the file itself fails the open,
// O_NONBLOCK so a FIFO swapped in cannot hang the request, and the opened handle must be a regular
// file. A swap of a folder ABOVE it is not closed: that needs `openat2(RESOLVE_BENEATH)`, which Bun
// does not expose. The only party who can win that race is someone who can write inside the root,
// which is the agent running as the operator's own user, and that agent can already read every file
// the bridge can. ADR 0065 accepted the same race for the untracked read.
//
// Pure where it can be (the path grammar, the order, the decoding); the disk half takes its file
// calls through {@link FilesFs}, so a test can stand one in.

import { constants, type Dirent } from "node:fs";
import { lstat, open, opendir, stat } from "node:fs/promises";
import { relative, sep } from "node:path";

import { isStateSecretName } from "./acl-policy.ts";
import { discoverRepos, gitBinary, looksBinary, MAX_FILE_READ_BYTES, runGit } from "./changes.ts";
import { isAbsoluteFolder, withinBound } from "./changes-root.ts";
import { HOST, type Host, isInside, splitPath } from "./host.ts";
import { containedRealpath, realpathOf } from "./journal/files.ts";
import type { FileEntry, FileReadAnswer, FilesListing } from "./types.ts";

// ── Limits ──────────────────────────────────────────────────────────────────────────────────────

/** Entries listed per folder before the listing is cut and says `truncated`. */
export const MAX_FILES_ENTRIES = 2000;
/** The most bytes read off one file: the Changes view's untracked-read cap. */
export const MAX_FILES_READ_BYTES = MAX_FILE_READ_BYTES;
/** The longest relative path accepted, in UTF-8 bytes (PATH_MAX on Linux). */
export const MAX_REL_PATH_BYTES = 4096;
/** The one `git check-ignore` a listing runs is killed after this long (Changes' runs get 5 s). */
export const IGNORE_TIMEOUT_MS = 2000;
/** Most bytes read off that run: 2000 names at the longest path, with room to spare. */
const MAX_IGNORE_OUTPUT_BYTES = 16 * 1024 * 1024;
/** `lstat` calls in flight at once while a listing sizes its rows. */
const LSTAT_CONCURRENCY = 32;

// ── The query ───────────────────────────────────────────────────────────────────────────────────

/** What a Files request asks: list a folder, or read a file. `path` wins when both are sent. */
export type FilesQuery = { mode: "list"; dir: string } | { mode: "read"; path: string };

/** The query, read once. `URLSearchParams` has already percent-decoded each value exactly once. */
export function filesQuery(url: URL): FilesQuery {
  const path = url.searchParams.get("path");
  if (path !== null) return { mode: "read", path };
  return { mode: "list", dir: url.searchParams.get("dir") ?? "" };
}

// ── The relative-path grammar ───────────────────────────────────────────────────────────────────

/** Windows device names: `CON`, `nul.txt`, `COM1` open a device, not a file, wherever they sit. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
/** Characters a Windows name cannot hold, or that a Windows API reads as a wildcard or a stream. */
const WINDOWS_BAD_CHARS = /[:*?"<>|]/;
/**
 * A Windows 8.3 short name (`PAIRED~1.JSO`, `PROGRA~1`) is another spelling of a long name, so the
 * name-based deny rules (`isStateSecretName`, `.git`) cannot see through it. Refused on the shape.
 */
const WINDOWS_SHORT_NAME = /~\d/;

/** A `.git` segment, on every host case-folded: refused for list and read, hidden from listings. */
export function isGitSegment(name: string): boolean {
  return name.toLowerCase() === ".git";
}

/**
 * The segments of a client's relative path, or `null` when its shape is refused. `""` is the root
 * and parses to no segments.
 *
 * Runs before any disk call. It does not decode anything: the value arrives decoded once by
 * `URLSearchParams`, so a `%252e%252e` the client double-encoded is the literal name `%2e%2e` here,
 * and a `%2F` is already the `/` it stood for.
 */
export function parseRelPath(raw: string, host: Host = HOST): string[] | null {
  if (raw === "") return [];
  if (new TextEncoder().encode(raw).byteLength > MAX_REL_PATH_BYTES) return null;
  if (raw.includes("\0") || raw.includes("\\")) return null;
  if (raw.startsWith("/")) return null;
  const segments = raw.split("/");
  const win = host.platform === "win32";
  for (const s of segments) {
    if (s === "" || s === "." || s === "..") return null;
    if (isGitSegment(s)) return null;
    if (win) {
      if (WINDOWS_BAD_CHARS.test(s)) return null;
      // Windows drops a trailing dot or space, so `.git.` IS `.git` and `secret ` is `secret`.
      if (s.endsWith(".") || s.endsWith(" ")) return null;
      if (WINDOWS_DEVICE.test(s)) return null;
      if (WINDOWS_SHORT_NAME.test(s)) return null;
    }
  }
  return segments;
}

// ── Order and text ──────────────────────────────────────────────────────────────────────────────

/** Folders first, then by name case-insensitive, then by exact name so the order is total. */
export function compareEntries(a: FileEntry, b: FileEntry): number {
  const fa = a.kind === "dir" ? 0 : 1;
  const fb = b.kind === "dir" ? 0 : 1;
  if (fa !== fb) return fa - fb;
  const la = a.name.toLowerCase();
  const lb = b.name.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** A file's bytes as the answer carries them. */
export interface DecodedText {
  binary: boolean;
  /** `""` when `binary`. */
  text: string;
}

/**
 * File bytes as the answer carries them. Binary (a NUL in the first 8000 bytes, `looksBinary` in
 * bridge/changes.ts, git's rule) is `""`. A cut file drops a multi-byte character the cap split
 * rather than ending in U+FFFD.
 */
export function decodeFileText(bytes: Uint8Array, truncated: boolean): DecodedText {
  if (looksBinary(bytes)) return { binary: true, text: "" };
  // `stream: true` holds back an incomplete trailing sequence instead of replacing it, which is
  // exactly "cut at a character boundary" for a read that stopped at the cap.
  return { binary: false, text: new TextDecoder("utf-8").decode(bytes, { stream: truncated }) };
}

// ── The disk, injectable ────────────────────────────────────────────────────────────────────────

/** The stat fields this module reads. */
export interface FilesStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: number;
}

/** The file calls this module makes. {@link NODE_FILES_FS} in production. */
export interface FilesFs {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<FilesStat>;
  lstat(path: string): Promise<FilesStat>;
  /** Up to `limit` names in `dir`, in the order the disk gives them, and whether more were there. */
  names(dir: string, limit: number, keep: (name: string) => boolean): Promise<{ names: string[]; more: boolean }>;
  /**
   * Open `path` without following a final symlink, refuse anything but a regular file, and read at
   * most `max` bytes from its start. `null` when the open or the type check refused it.
   */
  readHead(path: string, max: number): Promise<{ bytes: Uint8Array; size: number; mtimeMs?: number } | null>;
  /** The real path containment, `containedRealpath` in production. */
  contained(candidate: string, root: string, host: Host): Promise<string | null>;
}

/** O_NOFOLLOW and O_NONBLOCK exist on POSIX only; Windows reads them as 0 (no flag). */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

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
  async readHead(path, max) {
    const handle = await open(path, OPEN_FLAGS).catch(() => null);
    if (handle === null) return null;
    try {
      const st = await handle.stat();
      if (!st.isFile()) return null;
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

// ── The root ────────────────────────────────────────────────────────────────────────────────────

/** Everything a Files read needs besides the request. */
export interface FilesContext {
  /** The root off the snapshot (bridge/changes-root.ts, or the bounded pane-cwd fallback). */
  root: string;
  /** The operator's home folder, the bound's upper end. */
  home: string;
  /** The bridge's state folder and config folder: denied, and hidden from listings. */
  privateFolders: readonly string[];
  host?: Host;
  fs?: FilesFs;
  /** Which listed names git ignores. {@link gitIgnoredNames} in production; a test stands one in. */
  ignoreProbe?: IgnoreProbe;
}

/** A host that folds case whatever the platform: the deny checks err towards refusing. */
function foldingHost(host: Host): Host {
  return host.caseInsensitive ? host : { ...host, caseInsensitive: true };
}

/** The pieces one request works with, after the root has been checked. */
interface Resolved {
  rootReal: string;
  /** Each private folder as given and as its real path; whichever spelling a target reaches. */
  denied: string[];
  host: Host;
  fs: FilesFs;
}

/**
 * The root's real path, when it is a folder and its real path is still narrow enough to read:
 * never `/`, home, or a folder above home, on the real paths of both. `null` reads as `no-folder`.
 */
async function resolveRoot(ctx: FilesContext): Promise<Resolved | null> {
  const host = ctx.host ?? HOST;
  const fs = ctx.fs ?? NODE_FILES_FS;
  if (!isAbsoluteFolder(ctx.root, host)) return null;
  const rootReal = await fs.realpath(ctx.root).catch(() => null);
  if (rootReal === null) return null;
  const st = await fs.stat(rootReal).catch(() => null);
  if (st === null || !st.isDirectory()) return null;
  const homeReal = await fs.realpath(ctx.home).catch(() => ctx.home);
  if (!withinBound(rootReal, homeReal, host) || !withinBound(rootReal, ctx.home, host)) return null;
  const denied: string[] = [];
  for (const folder of ctx.privateFolders) {
    if (folder.trim() === "") continue;
    denied.push(folder);
    const real = await fs.realpath(folder).catch(() => null);
    if (real !== null && real !== folder) denied.push(real);
  }
  return { rootReal, denied, host, fs };
}

/**
 * Whether a real path is one this view never shows: a `.git` segment, a state secret's basename, or
 * a private folder's inside.
 */
function isDeniedReal(real: string, r: Resolved): boolean {
  const parts = splitPath(r.host, real).parts;
  if (parts.some(isGitSegment)) return true;
  const base = parts.at(-1);
  if (base !== undefined && isStateSecretName(base)) return true;
  const fold = foldingHost(r.host);
  return r.denied.some((folder) => isInside(fold, real, folder));
}

/**
 * The real path of `segments` under the root, when it is inside the root and not denied. `null` is
 * `unknown-path`, whatever the cause.
 */
async function checkedTarget(segments: readonly string[], r: Resolved): Promise<string | null> {
  const last = segments.at(-1);
  if (last !== undefined && isStateSecretName(last)) return null;
  const candidate = segments.length === 0 ? r.rootReal : r.host.path.join(r.rootReal, ...segments);
  const real = await r.fs.contained(candidate, r.rootReal, r.host);
  if (real === null) return null;
  return isDeniedReal(real, r) ? null : real;
}

/** `unknown-path`: the one answer for absent, outside, denied, and the wrong kind. */
export const UNKNOWN_PATH = "unknown-path" as const;

/** The result of a Files call: an answer for the body, or the one refusal. */
export type FilesResult<T> = T | typeof UNKNOWN_PATH;

// ── Ignored, asked of git ───────────────────────────────────────────────────────────────────────

/**
 * Which of a folder's entries git ignores, as the set of names, or `null` when git gave no answer
 * (no git, no repository, a timeout, an error). `null` is the quiet case: the listing still answers,
 * with no `ignored` flag on any row.
 */
export type IgnoreProbe = (realDir: string, entries: readonly FileEntry[]) => Promise<ReadonlySet<string> | null>;

/**
 * ONE `git check-ignore --stdin -z` for one listing, through the same hardened runner Changes uses
 * (bridge/changes.ts: argv only, no shell, no inherited `GIT_*`, no hook, no network).
 *
 * - The repository is the nearest `.git` ABOVE the listed folder's real path, so a nested clone
 *   inside the root answers with its own rules, and a folder outside any repository answers `null`.
 * - The names travel on stdin, NUL-separated, never in argv: a name with a newline or a leading dash
 *   is one path. `check-ignore` refuses `--literal-pathspecs`, so each path is spelled `./name`,
 *   which no pathspec magic (`:(top)`, `:!`) can start with.
 * - No `--no-index`: a tracked file that matches an ignore rule is not ignored, which is git's own
 *   answer and the one an operator expects.
 * - A directory is passed without a trailing slash: git looks the path up and applies a `build/`
 *   rule to it, and a trailing slash on a symlink is a fatal "beyond a symbolic link".
 * - A child of an ignored folder is reported ignored by git itself, so a listing opened inside
 *   `node_modules` comes back whole.
 * - Exit 0 (some ignored) and 1 (none) are answers. Anything else, a cut-off or a timeout is `null`.
 */
export async function gitIgnoredNames(
  realDir: string,
  entries: readonly FileEntry[],
  opts: { timeoutMs?: number; git?: string } = {},
): Promise<ReadonlySet<string> | null> {
  if (entries.length === 0) return null;
  try {
    const git = opts.git ?? (await gitBinary());
    if (git === null) return null;
    const repo = (await discoverRepos(realDir, 1, false)).repos[0];
    if (repo === undefined) return null;
    const rel = relative(repo.workTree, realDir).split(sep).join("/");
    const asked = new Map<string, string>();
    // `./` first: a name that starts with `:` or `-` can then never read as pathspec magic or a flag.
    for (const { name } of entries) asked.set(`./${rel === "" ? name : `${rel}/${name}`}`, name);
    const input = new TextEncoder().encode(`${[...asked.keys()].join("\0")}\0`);
    const run = await runGit(git, repo, ["check-ignore", "--stdin", "-z"], [], MAX_IGNORE_OUTPUT_BYTES, {
      input,
      timeoutMs: opts.timeoutMs ?? IGNORE_TIMEOUT_MS,
      literalPathspecs: false,
    });
    if (run.timedOut || run.capped || (run.code !== 0 && run.code !== 1)) return null;
    const ignored = new Set<string>();
    for (const path of run.stdout.toString("utf8").split("\0")) {
      const name = asked.get(path);
      if (name !== undefined) ignored.add(name);
    }
    return ignored;
  } catch {
    return null;
  }
}

// ── List ────────────────────────────────────────────────────────────────────────────────────────

/** Run `fn` over `items`, at most `limit` at once, keeping order. */
async function mapLimited<T, U>(items: readonly T[], limit: number, fn: (item: T) => Promise<U>): Promise<U[]> {
  const out: U[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * One folder under the root: one directory read, one `lstat` per kept entry, one `git check-ignore`
 * for the kept entries ({@link gitIgnoredNames}), no walk. A `.git`
 * entry, a state secret's name and a private folder are skipped before the cap counts them; a socket, FIFO or device is
 * dropped after, since it is neither a folder to open nor a file to read.
 */
export async function listFolder(ctx: FilesContext, dir: string): Promise<FilesResult<FilesListing>> {
  const r = await resolveRoot(ctx);
  if (r === null) return { available: false, reason: "no-folder" };
  const segments = parseRelPath(dir, r.host);
  if (segments === null) return UNKNOWN_PATH;
  try {
    const real = await checkedTarget(segments, r);
    if (real === null) return UNKNOWN_PATH;
    const st = await r.fs.stat(real).catch(() => null);
    if (st === null || !st.isDirectory()) return UNKNOWN_PATH;
    const fold = foldingHost(r.host);
    const keep = (name: string): boolean =>
      !isGitSegment(name) &&
      !isStateSecretName(name) &&
      !r.denied.some((folder) => isInside(fold, r.host.path.join(real, name), folder));
    const { names, more } = await r.fs.names(real, MAX_FILES_ENTRIES, keep);
    const rows = await mapLimited(names, LSTAT_CONCURRENCY, async (name): Promise<FileEntry | null> => {
      const ls = await r.fs.lstat(r.host.path.join(real, name)).catch(() => null);
      if (ls === null) return null;
      if (ls.isSymbolicLink()) return { name, kind: "link" };
      if (ls.isDirectory()) return { name, kind: "dir" };
      if (ls.isFile()) return { name, kind: "file", size: ls.size };
      return null;
    });
    const listed = rows.filter((e): e is FileEntry => e !== null).toSorted(compareEntries);
    const ignored = await (ctx.ignoreProbe ?? gitIgnoredNames)(real, listed).catch(() => null);
    const entries =
      ignored === null || ignored.size === 0
        ? listed
        : listed.map((e): FileEntry => (ignored.has(e.name) ? Object.assign({}, e, { ignored: true as const }) : e));
    return { available: true, root: ctx.root, dir: segments.join("/"), entries, truncated: more };
  } catch {
    return UNKNOWN_PATH;
  }
}

// ── Read ────────────────────────────────────────────────────────────────────────────────────────

/** One file under the root, cut at {@link MAX_FILES_READ_BYTES}. A folder is `unknown-path`. */
export async function readFile(ctx: FilesContext, path: string): Promise<FilesResult<FileReadAnswer>> {
  const r = await resolveRoot(ctx);
  if (r === null) return { available: false, reason: "no-folder" };
  const segments = parseRelPath(path, r.host);
  if (segments === null || segments.length === 0) return UNKNOWN_PATH;
  try {
    const real = await checkedTarget(segments, r);
    if (real === null) return UNKNOWN_PATH;
    const head = await r.fs.readHead(real, MAX_FILES_READ_BYTES);
    if (head === null) return UNKNOWN_PATH;
    const truncated = head.size > MAX_FILES_READ_BYTES;
    const { binary, text } = decodeFileText(head.bytes, truncated);
    const answer: FileReadAnswer = { available: true, root: ctx.root, path: segments.join("/"), size: head.size, binary, truncated, text };
    if (head.mtimeMs !== undefined) answer.mtimeMs = head.mtimeMs;
    return answer;
  } catch {
    return UNKNOWN_PATH;
  }
}

// ── Image ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The most bytes one picture may have (ADR 0090). The blob route's ceiling (`BLOB_MAX_BYTES` in
 * bridge/server.ts), for the same reason: a phone on a cellular link is the reader, and past this a
 * picture costs more to send than it is worth. A larger file answers `too-large` before it is opened.
 */
export const MAX_IMAGE_READ_BYTES = 16 * 1024 * 1024;

/** The picture types the image read serves. SVG is not one of them: it is text (ADR 0090). */
export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif";

/** The leading bytes {@link sniffImageType} reads at most: an `ftyp` box's brands, generously. */
export const IMAGE_SNIFF_BYTES = 64;

/** Whether `head` holds the ASCII text `ascii` at `offset`. */
function bytesAt(head: Uint8Array, offset: number, ascii: string): boolean {
  if (head.length < offset + ascii.length) return false;
  for (let i = 0; i < ascii.length; i++) if (head[offset + i] !== ascii.charCodeAt(i)) return false;
  return true;
}

/**
 * Whether an ISO-BMFF `ftyp` box at the start of `head` names an AVIF brand (`avif` for a still,
 * `avis` for a sequence), as its major brand or as one of its compatible brands. A HEIC photo has the
 * same box with other brands, and a browser that draws AVIF does not draw HEIC, so it is no match.
 */
function isAvif(head: Uint8Array): boolean {
  if (!bytesAt(head, 4, "ftyp")) return false;
  const size = ((head[0]! << 24) | (head[1]! << 16) | (head[2]! << 8) | head[3]!) >>> 0;
  // The major brand at 8, the minor version at 12, then four-byte compatible brands to the box's end,
  // read only as far as the bytes in hand reach.
  const end = Math.min(size, head.length);
  if (end < 12) return false;
  for (let at = 8; at + 4 <= end; at += at === 8 ? 8 : 4) {
    if (bytesAt(head, at, "avif") || bytesAt(head, at, "avis")) return true;
  }
  return false;
}

/**
 * The type of a picture, read off its leading bytes and NOTHING ELSE (ADR 0090). The extension is
 * the agent's word, or a stranger's: a text file renamed `x.png` is not a picture, and a type taken
 * from its name would hand the browser bytes under a label they do not match. `null` is every file
 * that is not one of the five types, and the route answers it `415`.
 *
 * - PNG: the full eight-byte signature, `\x89PNG\r\n\x1a\n`.
 * - JPEG: `FF D8 FF`, the start-of-image marker and the first marker after it.
 * - GIF: `GIF87a` or `GIF89a`. An animated GIF is a GIF, and the phone draws it animating.
 * - WebP: `RIFF` at 0 and `WEBP` at 8. `RIFF` alone is also a WAV or an AVI.
 * - AVIF: an `ftyp` box at 4 that names `avif` or `avis` ({@link isAvif}).
 */
export function sniffImageType(head: Uint8Array): ImageType | null {
  if (head.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => head[i] === b)) return "image/png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (bytesAt(head, 0, "GIF87a") || bytesAt(head, 0, "GIF89a")) return "image/gif";
  if (bytesAt(head, 0, "RIFF") && bytesAt(head, 8, "WEBP")) return "image/webp";
  if (isAvif(head)) return "image/avif";
  return null;
}

/**
 * What an image read comes to: the picture, a file over {@link MAX_IMAGE_READ_BYTES}, a file that is
 * not one of the five types, or a root that is not there to read.
 */
export type ImageReadAnswer =
  | { available: false; reason: "no-folder" }
  | { available: true; kind: "image"; type: ImageType; bytes: Uint8Array; size: number; mtimeMs?: number }
  | { available: true; kind: "too-large"; size: number }
  | { available: true; kind: "not-image" };

/**
 * One picture under the root (ADR 0090), through exactly the checks {@link readFile} runs: the same
 * root, the same shape rule, the same real-path containment and deny list, the same no-follow open of
 * a regular file. Only the cap and the answer differ. The file is sized before it is opened, so a
 * video asked for as a picture is refused without a read, and sized again on the open handle, so a
 * file that grew in between is refused too. The type comes off the bytes ({@link sniffImageType}).
 */
export async function readImage(ctx: FilesContext, path: string): Promise<FilesResult<ImageReadAnswer>> {
  const r = await resolveRoot(ctx);
  if (r === null) return { available: false, reason: "no-folder" };
  const segments = parseRelPath(path, r.host);
  if (segments === null || segments.length === 0) return UNKNOWN_PATH;
  try {
    const real = await checkedTarget(segments, r);
    if (real === null) return UNKNOWN_PATH;
    const st = await r.fs.stat(real).catch(() => null);
    if (st === null || !st.isFile()) return UNKNOWN_PATH;
    if (st.size > MAX_IMAGE_READ_BYTES) return { available: true, kind: "too-large", size: st.size };
    const head = await r.fs.readHead(real, MAX_IMAGE_READ_BYTES);
    if (head === null) return UNKNOWN_PATH;
    if (head.size > MAX_IMAGE_READ_BYTES) return { available: true, kind: "too-large", size: head.size };
    const type = sniffImageType(head.bytes.subarray(0, IMAGE_SNIFF_BYTES));
    if (type === null) return { available: true, kind: "not-image" };
    const picture: ImageReadAnswer = { available: true, kind: "image", type, bytes: head.bytes, size: head.size };
    if (head.mtimeMs !== undefined) picture.mtimeMs = head.mtimeMs;
    return picture;
  } catch {
    return UNKNOWN_PATH;
  }
}

// ── Exist ───────────────────────────────────────────────────────────────────────────────────────

/** The most paths one existence check may name (ADR 0088). More is a refused body, not a cut. */
export const MAX_EXIST_PATHS = 64;

/** What an existence check answers: the asked paths that are a regular file or a folder. */
export interface FilesExistAnswer {
  exists: string[];
}

/**
 * Which of `paths` name a regular file or a folder under the root, in the order asked, each once
 * (ADR 0088). A path passes the same checks a read runs (the shape, the real path inside the root's,
 * `.git`, the private folders, a state secret's basename), then takes ONE `lstat` on its real path.
 * Nothing is opened and no byte is read. Everything the read would refuse is absent here, and so is
 * the root itself, a FIFO and a socket: an absent path and a refused one cannot be told apart, as on
 * the read.
 */
export async function existingPaths(ctx: FilesContext, paths: readonly string[]): Promise<string[]> {
  const asked = [...new Set(paths)];
  if (asked.length === 0) return [];
  const r = await resolveRoot(ctx);
  if (r === null) return [];
  const found = await mapLimited(asked, LSTAT_CONCURRENCY, async (path): Promise<boolean> => {
    const segments = parseRelPath(path, r.host);
    if (segments === null || segments.length === 0) return false;
    try {
      const real = await checkedTarget(segments, r);
      if (real === null) return false;
      // The real path holds no link by construction; one swapped in since is a link here, and absent,
      // the way O_NOFOLLOW refuses it on the read.
      const st = await r.fs.lstat(real).catch(() => null);
      return st !== null && !st.isSymbolicLink() && (st.isFile() || st.isDirectory());
    } catch {
      return false;
    }
  });
  return asked.filter((_, i) => found[i] === true);
}

/** List or read, as the query asks. */
export function serveFiles(ctx: FilesContext, query: FilesQuery): Promise<FilesResult<FilesListing | FileReadAnswer>> {
  return query.mode === "read" ? readFile(ctx, query.path) : listFolder(ctx, query.dir);
}
