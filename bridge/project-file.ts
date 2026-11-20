// THE PROJECT FILE, `collie.toml` (issue 811, ADR 0160): a file in a repository that changes what
// Collie SHOWS for the sessions working in it, and nothing else.
//
//   # collie.toml, in the repository root
//   [project]
//   icon = "assets/logo.png"
//
// ── DISPLAY ONLY ─────────────────────────────────────────────────────────────────────────────────
// A cloned repository and the agent working in it can both write this file, so every byte of it is
// untrusted input, the same class as agent output. It never defines a command, a launcher, a key, a
// hook, a trick, or anything that types into a session, opens a port or reaches the network. The
// table names `commands`, `launch`, `keys` and `hooks` are never read here, whatever a later release
// adds (ADR 0160). What it may say is the fixed list {@link PROJECT_KEYS}: one table per subject, one
// validator per key. A later key (`name`, `color`) or a later table is one more entry there. There is
// no free-form part and no version field: keys are only ever added, and an unknown key or table is
// ignored, never an error. `collie doctor` lists what was ignored, by name only.
//
// ── WHICH FILE ───────────────────────────────────────────────────────────────────────────────────
// The nearest one wins ({@link locateProjectFile}): from the session's folder upward to the root of
// its repository, the first `collie.toml` is the one. No merging. Never above the repository root. A
// folder outside any repository reads only a `collie.toml` in that folder itself. A linked git
// worktree reads its own tree first, then the main checkout, from the same folder inside it upward.
// When the session's own repository has no file, an ENCLOSING repository's does (a workspace that holds
// member repositories as folders): from the folder holding the member up to the workspace's root, by the
// same rules, through at most {@link ENCLOSING_MAX} enclosing repositories (ADR 0160).
// Every step is on the REAL path of the session's folder, so a symlinked folder name cannot lift the
// walk out of the tree it really is in.
//
// ── HOW IT IS READ ───────────────────────────────────────────────────────────────────────────────
// The file is at most {@link PROJECT_FILE_BYTES_MAX} bytes. `lstat` first: a symlink, a folder, a FIFO,
// a device or a socket named `collie.toml` is refused, not followed and not opened. Then it is opened
// with O_NOFOLLOW and O_NONBLOCK, the open handle must be the same regular file the `lstat` saw (dev
// and inode), and at most the cap plus one byte is read. Text that is not UTF-8 is refused. A file
// that is refused stops the walk all the same: it is the nearest one, and it says nothing.

import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

import { asJsonObject, asJsonString, type JsonObject, type JsonValue } from "../web/src/lib/json.ts";
import { parseGitFile } from "./git-head.ts";
import { HOST } from "./host.ts";

/** The file's name, in the folder it speaks for. */
export const PROJECT_FILE_NAME = "collie.toml";
/** The largest project file that is read at all. */
export const PROJECT_FILE_BYTES_MAX = 16 * 1024;
/** The longest text value a key takes (the icon's path). */
export const PROJECT_TEXT_MAX = 256;
/** A `.git` file and a `commondir` file are one short line each. */
const GIT_POINTER_BYTES_MAX = 4096;
/** The walk up never takes more steps than this, whatever the tree. */
const WALK_DEPTH_MAX = 64;
/** How many ignored names a report keeps, and how long each may be. */
const IGNORED_MAX = 32;
const IGNORED_NAME_MAX = 64;

/** Table names a project file may never use, named so a reader of the code meets the rule (ADR 0160). */
export const NEVER_TABLES = ["commands", "launch", "keys", "hooks"] as const;

const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** What a project file says, after validation. Every field optional: absent means "not said". */
export interface ProjectSettings {
  /** `[project] icon`: a relative path below the repository root, checked by {@link checkIconPath}. */
  readonly icon?: string;
}

/** One key's validator: the value as kept, or a short reason it is refused. */
type KeyCheck = (value: JsonValue | undefined) => KeyResult;
/** What one validator answers. */
export type KeyResult = { ok: true; value: string } | { ok: false; why: string };

/**
 * THE FIXED LIST. Each table a project file may hold, each key in it, and the one validator that key
 * goes through. Nothing outside this list is read. A table named in {@link NEVER_TABLES} must never be
 * added here (ADR 0160); `project-file.test.ts` holds that.
 */
export const PROJECT_KEYS = {
  project: {
    icon: checkIconPath,
  },
} as const satisfies ProjectKeyList;

/** The keys of one table, each with its validator. */
type KeyTable = Readonly<Record<string, KeyCheck>>;
/** Every table a project file may hold. */
type ProjectKeyList = Readonly<Record<string, KeyTable>>;

/** The validated settings, the names that were ignored, and the values that were refused. */
export interface ProjectFileRead {
  readonly settings: ProjectSettings;
  /** Tables and keys this release does not know, as `table` or `table.key`. Names only, cleaned. */
  readonly ignored: readonly string[];
  /** Keys this release knows whose value was refused, as `table.key: reason`. */
  readonly refused: readonly string[];
}

/**
 * A code a terminal or a reader may act on rather than print: a C0 control, DEL, a C1 control (U+0080 to
 * U+009F; U+009B is a one-byte CSI), the line and paragraph separators U+2028 and U+2029, the bidi
 * marks (U+200E, U+200F, U+061C), and the bidi embeddings, overrides and isolates (U+202A to U+202E,
 * U+2066 to U+2069). `collie doctor` prints names from this file, so none of these may reach it.
 */
export function isControlCode(code: number): boolean {
  if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  if (code === 0x2028 || code === 0x2029 || code === 0x200e || code === 0x200f || code === 0x061c) return true;
  return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

/** Whether a text holds any {@link isControlCode}. */
function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (isControlCode(text.charCodeAt(i))) return true;
  return false;
}

/** A name from the file, safe to print in a terminal: controls dropped, cut to a length. */
export function cleanName(name: string): string {
  return cleanText(name, IGNORED_NAME_MAX);
}

/** Any text for a terminal (a name, a folder path): every {@link isControlCode} dropped, cut to `max`. */
export function cleanText(text: string, max: number): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (isControlCode(code)) continue;
    out += ch;
    if (out.length >= max) break;
  }
  return out === "" ? "?" : out;
}

/**
 * `[project] icon`: a relative path, `/`-separated, that stays inside the repository by its text alone.
 * The disk checks (no symlink at any step, inside after resolving) come later, in project-picture.ts.
 */
export function checkIconPath(raw: JsonValue | undefined): KeyResult {
  const value = asJsonString(raw);
  if (value === undefined) return { ok: false, why: "is not a text" };
  if (value.length === 0 || value.length > PROJECT_TEXT_MAX) return { ok: false, why: `is empty or longer than ${String(PROJECT_TEXT_MAX)} characters` };
  if (hasControl(value) || value.includes("\0")) return { ok: false, why: "holds a control character" };
  if (value.includes("\\")) return { ok: false, why: "uses a backslash; write the path with /" };
  // The value is the repository's text, not a host path, so it is read the same on every host: a
  // leading separator of either kind, a home `~` or a drive letter is not relative, and both kinds of
  // separator split a step (the backslash is refused above, and this keeps the rule if that changes).
  if (/^(?:[/\\~]|[A-Za-z]:)/.test(value)) return { ok: false, why: "is not a relative path" };
  const parts = value.split(/[/\\]/);
  if (parts.some((p) => p === "" || p === "." || p === "..")) return { ok: false, why: "has an empty, . or .. step" };
  if (parts.some((p) => p.toLowerCase() === ".git")) return { ok: false, why: "is under .git" };
  return { ok: true, value };
}

/** A plain TOML table (not an array, not a date), as Bun's parser answers one. */
function tableOf(value: JsonValue | undefined): JsonObject | undefined {
  return value instanceof Date ? undefined : asJsonObject(value);
}

/** The keys of a table this release knows, by an own-property lookup only (no prototype member). */
function knownTable(name: string, list: ProjectKeyList = PROJECT_KEYS): KeyTable | undefined {
  return Object.hasOwn(list, name) ? list[name] : undefined;
}

/** One key's validator in a known table, by an own-property lookup only. */
function knownKey(table: KeyTable, name: string): KeyCheck | undefined {
  return Object.hasOwn(table, name) ? table[name] : undefined;
}

/**
 * The text of a project file as {@link ProjectFileRead}. Total: a parse error answers empty settings and
 * one refusal, never a throw. Unknown tables and keys are listed in `ignored`, never an error.
 */
export function parseProjectFile(text: string): ProjectFileRead & { readonly parseError: boolean } {
  let doc: JsonObject | undefined;
  try {
    // SAFETY: `Bun.TOML.parse` answers a document of tables, arrays, strings, numbers, booleans and
    // dates. Every value read below goes through `tableOf` or a key's validator before it is believed,
    // and a date is refused by both, so this claims nothing beyond "a document came back".
    doc = tableOf(Bun.TOML.parse(text) as JsonValue);
  } catch {
    return { settings: {}, ignored: [], refused: ["the file is not valid TOML"], parseError: true };
  }
  const ignored: string[] = [];
  const refused: string[] = [];
  let icon: string | undefined;
  const note = (name: string) => {
    if (ignored.length < IGNORED_MAX) ignored.push(cleanName(name));
  };
  for (const [table, value] of Object.entries(doc ?? {})) {
    const known = knownTable(table);
    const body = tableOf(value);
    if (known === undefined || body === undefined) {
      note(table);
      continue;
    }
    for (const [key, field] of Object.entries(body)) {
      const check = knownKey(known, key);
      if (check === undefined) {
        note(`${table}.${key}`);
        continue;
      }
      const result = check(field);
      if (!result.ok) {
        if (refused.length < IGNORED_MAX) refused.push(`${table}.${key} ${result.why}`);
        continue;
      }
      if (table === "project" && key === "icon") icon = result.value;
    }
  }
  const settings: ProjectSettings = icon === undefined ? {} : { icon };
  return { settings, ignored, refused, parseError: false };
}

/** Where a session's project file is, and the repository root that bounds what it may name. */
export interface LocatedProjectFile {
  /** The file's absolute real path. */
  readonly file: string;
  /** The root of the tree the file was found in: what an icon must stay below. */
  readonly root: string;
  /**
   * Set when the file came from an ENCLOSING repository (a workspace that holds the session's repository
   * as a folder): that repository's root, which `root` then also is. Absent for the session's own tree.
   */
  readonly enclosing?: string;
}

/** What a path is, without following a link. `null` when it does not exist or cannot be read. */
async function kindOf(path: string): Promise<"file" | "dir" | "link" | "other" | null> {
  try {
    const s = await lstat(path);
    if (s.isSymbolicLink()) return "link";
    if (s.isDirectory()) return "dir";
    return s.isFile() ? "file" : "other";
  } catch {
    return null;
  }
}

/**
 * Whether an open descriptor is the file at `real`, the path's real path taken before the open. On
 * Linux the kernel's own name for the descriptor (`/proc/self/fd/<n>`) must be `real`; elsewhere a fresh
 * `lstat` of `real` must be a regular file with the descriptor's device and inode, and `real` must be
 * its own real path. So a folder on the way swapped for a link between the check and the open reads
 * nothing. Without that last rule, off Linux a path through a linked folder passed whenever the link
 * led to the same file (#830's Windows run, 2026-11-20): `lstat` follows every step but the last.
 * `platform` is the host's; a test passes another to run the other branch here.
 */
export async function descriptorIs(fd: number, real: string, opened: { dev: number; ino: number }, platform: NodeJS.Platform = HOST.platform): Promise<boolean> {
  if (platform === "linux") {
    try {
      return (await readlink(`/proc/self/fd/${String(fd)}`)) === real;
    } catch {
      return false;
    }
  }
  try {
    const now = await lstat(real);
    if (!now.isFile() || now.dev !== opened.dev || now.ino !== opened.ino) return false;
    return (await realpath(real)) === real;
  } catch {
    return false;
  }
}

/**
 * The bytes of a small regular file, or `null`. Never follows a link at the last step, never blocks on a
 * FIFO, and reads only when the open descriptor is the file `lstat` saw (device and inode) and sits at
 * `expected` ({@link descriptorIs}). The size is checked on `lstat` and again on the open descriptor
 * before any read, and at most `max` plus one byte is read. Shared by the project file and the project
 * picture (project-picture.ts).
 *
 * `expected` is the real path the CALLER already checked (its private-folder list, its `.git` rule, its
 * repository bound). The descriptor is compared with exactly that path, never with a second resolve made
 * here: a folder on the way swapped for a link between the caller's check and the open would pass a
 * fresh resolve, and reads nothing this way. Only a caller that checked nothing about the path (a git
 * pointer file) leaves `expected` out, and then the path's own real path stands in. `seen` is the
 * device and inode of the caller's own first `lstat`: the open file must be that file, on every host
 * (off Linux a fresh `lstat` could follow a swapped folder to the outside file).
 */
export async function readSmallFile(path: string, max: number, expected?: string, seen?: { dev: number; ino: number }): Promise<Uint8Array | null> {
  let link: Awaited<ReturnType<typeof lstat>>;
  let real: string;
  try {
    link = await lstat(path);
    if (!link.isFile() || link.size > max) return null;
    if (seen !== undefined && (link.dev !== seen.dev || link.ino !== seen.ino)) return null;
    real = expected ?? (await realpath(path));
  } catch {
    return null;
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, OPEN_FLAGS);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== link.dev || opened.ino !== link.ino || opened.size > max) return null;
    if (!(await descriptorIs(handle.fd, real, opened))) return null;
    const buf = Buffer.alloc(max + 1);
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await handle.read(buf, got, buf.length - got, got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return got > max ? null : new Uint8Array(buf.subarray(0, got));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** The tree a real folder sits in: its root, and for a linked worktree the main checkout's root. */
interface Tree {
  readonly root: string;
  readonly main: string | null;
}

/**
 * The repository a real folder belongs to, or `null` outside one. Walks up to the first `.git`. A `.git`
 * FILE is a linked worktree or a submodule: its git dir's `commondir` names the shared git dir, and when
 * that is a folder named `.git` its parent is the main checkout. A submodule has no `commondir`, so it is
 * a tree of its own. A level that is itself a git dir (a bare repo) stops the walk outside any tree.
 */
async function treeOf(folder: string): Promise<Tree | null> {
  let dir = folder;
  for (let depth = 0; depth < WALK_DEPTH_MAX; depth++) {
    const dotGit = join(dir, ".git");
    const kind = await kindOf(dotGit);
    if (kind === "dir") return { root: dir, main: null };
    if (kind === "file") return { root: dir, main: await mainCheckoutOf(dotGit, dir) };
    if ((await kindOf(join(dir, "HEAD"))) === "file" && (await kindOf(join(dir, "objects"))) === "dir") return null;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/**
 * The main checkout's real root for a linked worktree's `.git` file, or `null`. The `.git` file and the
 * `commondir` it leads to are the repository's own text, so they are believed only in git's own layout,
 * on real paths: the git dir is exactly `<common>/worktrees/<name>`, and `<common>` is a real folder
 * named `.git` whose parent is the main checkout. Anything else (a `commondir` that names another
 * repository's `.git`, a git dir outside `worktrees`) is a tree of its own, with no main checkout.
 */
async function mainCheckoutOf(dotGitFile: string, root: string): Promise<string | null> {
  const pointer = await readSmallFile(dotGitFile, GIT_POINTER_BYTES_MAX);
  if (pointer === null) return null;
  const gitDir = parseGitFile(Buffer.from(pointer).toString("utf8"), root);
  if (gitDir === null) return null;
  const common = await readSmallFile(join(gitDir, "commondir"), GIT_POINTER_BYTES_MAX);
  if (common === null) return null;
  const line = Buffer.from(common).toString("utf8").split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (line === "" || hasControl(line)) return null;
  const commonDir = isAbsolute(line) ? normalize(line) : resolve(gitDir, line);
  let gitDirReal: string;
  let commonReal: string;
  try {
    gitDirReal = await realpath(gitDir);
    commonReal = await realpath(commonDir);
  } catch {
    return null;
  }
  if (basename(commonReal) !== ".git" || (await kindOf(commonReal)) !== "dir") return null;
  if (dirname(gitDirReal) !== join(commonReal, "worktrees") || basename(gitDirReal) === "") return null;
  // Git's back link: `<common>/worktrees/<name>/gitdir` names the worktree's own `.git` file. It must be
  // THIS `.git` file, on real paths, or a `.git` file could borrow another repository's real worktree
  // entry and with it that repository's `collie.toml`.
  const back = await readSmallFile(join(gitDirReal, "gitdir"), GIT_POINTER_BYTES_MAX);
  if (back === null) return null;
  const backLine = Buffer.from(back).toString("utf8").split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (backLine === "" || hasControl(backLine)) return null;
  let backReal: string;
  let selfReal: string;
  try {
    backReal = await realpath(isAbsolute(backLine) ? normalize(backLine) : resolve(gitDirReal, backLine));
    selfReal = await realpath(dotGitFile);
  } catch {
    return null;
  }
  if (backReal !== selfReal) return null;
  const main = dirname(commonReal);
  return main === root ? null : main;
}

/** `true` when `child` is `parent` or below it, on real paths of one host. */
function within(parent: string, child: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes("..");
}

/**
 * The first `collie.toml` from `start` up to `root`, both real paths with `start` at or below `root`.
 * Any entry by that name ends the walk, a folder or a link included: it is the nearest, and a refused
 * nearest file means no settings rather than a reach further up.
 */
async function nearestIn(start: string, root: string): Promise<string | null> {
  let dir = start;
  for (let depth = 0; depth < WALK_DEPTH_MAX; depth++) {
    const candidate = join(dir, PROJECT_FILE_NAME);
    if ((await kindOf(candidate)) !== null) return candidate;
    if (dir === root) return null;
    const up = dirname(dir);
    if (up === dir || !within(root, up)) return null;
    dir = up;
  }
  return null;
}

/**
 * The project file that speaks for a session's folder, or `null` when none does. The rule is this
 * file's header ("WHICH FILE"). Never throws.
 */
export async function locateProjectFile(folder: string): Promise<LocatedProjectFile | null> {
  if (!isAbsolute(folder)) return null;
  let real: string;
  try {
    real = await realpath(folder);
  } catch {
    return null;
  }
  if ((await kindOf(real)) !== "dir") return null;
  let tree = await treeOf(real);
  if (tree === null) {
    const own = join(real, PROJECT_FILE_NAME);
    return (await kindOf(own)) === null ? null : { file: own, root: real };
  }
  const found = await locateInTree(real, tree);
  if (found !== null) return found;
  // THE ENCLOSING REPOSITORY (R8, ADR 0160): a workspace repository that holds this one as a plain folder.
  // Its file speaks for a session in a member that has none, from the folder that holds the member up to
  // the workspace's own root, by the same rules (its icon stays inside the workspace). A member's own
  // file always wins, because it is searched first. At most ENCLOSING_MAX levels.
  for (let level = 0; level < ENCLOSING_MAX; level++) {
    const parent = dirname(tree.root);
    if (parent === tree.root) return null;
    const enclosing = await treeOf(parent);
    if (enclosing === null) return null;
    const shared = await locateInTree(parent, enclosing);
    if (shared !== null) return { ...shared, enclosing: shared.root };
    tree = enclosing;
  }
  return null;
}

/** How many enclosing repositories the search goes through, at most, above the session's own. */
export const ENCLOSING_MAX = 4;

/**
 * The nearest file from a real folder up to its tree's root, then, for a linked worktree, from the same
 * folder inside the main checkout up to that root.
 */
async function locateInTree(real: string, tree: Tree): Promise<LocatedProjectFile | null> {
  const own = await nearestIn(real, tree.root);
  if (own !== null) return { file: own, root: tree.root };
  if (tree.main === null) return null;
  // The same folder inside the main checkout, which may not exist there: the walk simply finds nothing
  // at the levels that are missing and goes on up.
  const inMain = join(tree.main, relative(tree.root, real));
  if (!within(tree.main, inMain)) return null;
  const shared = await nearestIn(inMain, tree.main);
  return shared === null ? null : { file: shared, root: tree.main };
}

/** One project file read off disk: its stamp (to know when to read it again) and what it says. */
export interface ProjectFileOnDisk extends ProjectFileRead {
  /** `dev:ino:size:mtime` of the file as `lstat` saw it, or `null` when it was refused before a read. */
  readonly stamp: string | null;
  /** Why the file as a whole was refused (not a regular file, too large, not UTF-8, not TOML). */
  readonly problem: string | null;
}

/** The `lstat` stamp of a path, or `null`. A changed stamp is the only reason to read a file again. */
export async function stampOf(path: string): Promise<string | null> {
  try {
    return stampOfStats(await lstat(path));
  } catch {
    return null;
  }
}

function stampOfStats(s: { dev: number; ino: number; size: number; mtimeMs: number; isFile(): boolean }): string {
  return `${String(s.dev)}:${String(s.ino)}:${String(s.size)}:${String(s.mtimeMs)}:${s.isFile() ? "f" : "x"}`;
}

/** Read and validate one project file by the rules of this file's header ("HOW IT IS READ"). */
export async function readProjectFile(path: string, between?: () => Promise<void>): Promise<ProjectFileOnDisk> {
  const empty = { settings: {}, ignored: [], refused: [] };
  // ONE `lstat` gives the stamp, the kind and the file the read must find (S3): off Linux the descriptor
  // check takes a fresh `lstat`, which a swapped folder would answer, so the device and inode seen here
  // travel with the read.
  let link: Awaited<ReturnType<typeof lstat>> | null;
  try {
    link = await lstat(path);
  } catch {
    link = null;
  }
  const stamp = link === null ? null : stampOfStats(link);
  if (link === null || !link.isFile()) return { ...empty, stamp, problem: link?.isSymbolicLink() === true ? "is a symlink" : "is not a regular file" };
  // A test's swap between the look and the read; nothing else passes it.
  await between?.();
  // `path` is a real path: the walk that found it ran on real paths (locateProjectFile).
  const bytes = await readSmallFile(path, PROJECT_FILE_BYTES_MAX, path, link);
  if (bytes === null) return { ...empty, stamp, problem: `is larger than ${String(PROJECT_FILE_BYTES_MAX / 1024)} KB or could not be read` };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ...empty, stamp, problem: "is not UTF-8 text" };
  }
  const read = parseProjectFile(text);
  return { settings: read.settings, ignored: read.ignored, refused: read.refused, stamp, problem: read.parseError ? "is not valid TOML" : null };
}
