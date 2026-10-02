// OWNER-ONLY: WHO MAY READ COLLIE'S SECRETS, ON EVERY HOST (M43 spec 04).
//
// The trust store, the pairing registry, push subscriptions, the VAPID key in `.env` and the rest
// must be readable by their owner only. On Linux and macOS the mode bits say that: files are 0600
// and the folders 0700. NTFS has no mode bits. `stat` reports 666 or 777 for everything and `chmod`
// flips only the read-only flag, so on Windows the guarantee must come from the access list (ACL).
//
// THE WINDOWS RULE. Collie does not set an ACL per file: a process per write is slow, and a file
// written first and fixed after is readable for a moment. Instead the PRIVATE FOLDERS (the state
// dir and the config dir) get a protected access list: nothing is inherited from the parent, and
// three principals get full control, which every file and folder created inside then inherits from
// its birth:
//
//   - the user Collie runs as (by SID, so a name with a space or a non-ASCII letter cannot break it),
//   - SYSTEM (S-1-5-18), and
//   - the local Administrators group (S-1-5-32-544).
//
// SYSTEM and Administrators stay because a normal Windows user profile already grants them exactly
// this (read on a fresh Windows 11 profile with `icacls`, 2026-10-02): SYSTEM runs backup, search
// and antivirus, and an administrator can take ownership of any file anyway, so a list without them
// protects nothing more and breaks the tools that expect them.
//
// THE CHECK. A path is NOT owner-only when an allow entry gives one of four broad principals the
// right to read it: Everyone (S-1-1-0), Users (S-1-5-32-545), Authenticated Users (S-1-5-11) or
// Guests (S-1-5-32-546). Inherited entries count, and so do inherit-only entries on a folder (they
// reach every new file). A deny entry is never a leak. The list is read as SDDL from `icacls /save`,
// which spells principals as SIDs. The plain `icacls` output names them in the system language
// (`Jeder`, `VORDEFINIERT\Benutzer` on a German Windows), so it is never parsed.
//
// A path whose list cannot be read is UNKNOWN, never loose: Collie says that it cannot say, and
// claims nothing about the file.
//
// On POSIX nothing here changes what Collie did before: `ensureOwnerOnlyDir` is the old
// `mkdir(..., { mode: 0o700 })` and nothing else, and the config loader keeps its mode rule.

import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PRIVATE_FILE_MODES, type PrivateFileVerdict } from "./config-source.ts";
import { type Host, hostFor, isInside, splitPath } from "./host.ts";

/** The host {@link secretFileVerdict} reads paths with: it runs on Windows only. */
const WINDOWS = hostFor("win32");

// ── The principals ───────────────────────────────────────────────────────────

/** The four principals that make a secret readable by other people, by SID, with a label to print. */
export const BROAD_PRINCIPALS: ReadonlyMap<string, string> = new Map([
  ["S-1-1-0", "Everyone"],
  ["S-1-5-32-545", "Users"],
  ["S-1-5-11", "Authenticated Users"],
  ["S-1-5-32-546", "Guests"],
]);

/** SYSTEM and the local Administrators group: the two that keep full control beside the user. */
export const SYSTEM_SID = "S-1-5-18";
export const ADMINISTRATORS_SID = "S-1-5-32-544";

/** The two-letter SDDL names of the SIDs this module reads. Any other alias is kept as written. */
const SDDL_ALIASES: ReadonlyMap<string, string> = new Map([
  ["WD", "S-1-1-0"],
  ["BU", "S-1-5-32-545"],
  ["AU", "S-1-5-11"],
  ["BG", "S-1-5-32-546"],
  ["SY", SYSTEM_SID],
  ["BA", ADMINISTRATORS_SID],
]);

/** `Users (S-1-5-32-545)`: the label first, then the SID, which is the same in every language. */
function principalLabel(sid: string): string {
  return `${BROAD_PRINCIPALS.get(sid) ?? sid} (${sid})`;
}

// ── Reading SDDL ─────────────────────────────────────────────────────────────

/** One access control entry, as much of it as the check reads. */
export interface Ace {
  /** `A` allow, `D` deny, `OA`/`XA`/`ZA` the other allow kinds, and so on. */
  readonly type: string;
  /** The inheritance flags, as written (`OICIID`). */
  readonly flags: string;
  /** The access mask. `null` when a right in it has no known value. */
  readonly mask: number | null;
  /** The SID, with the two-letter aliases this module knows spelled out. */
  readonly sid: string;
}

/** A discretionary access list (DACL). `aces: null` is a null DACL: no list at all, so anyone may do anything. */
export interface Dacl {
  /** `P`: nothing is inherited from the parent folder. */
  readonly protected: boolean;
  readonly aces: readonly Ace[] | null;
}

// The access-right letters SDDL writes, with their mask values (Microsoft's "ACE strings" page).
const RIGHTS: ReadonlyMap<string, number> = new Map([
  ["GA", 0x10000000],
  ["GR", 0x80000000],
  ["GW", 0x40000000],
  ["GX", 0x20000000],
  ["RC", 0x20000],
  ["SD", 0x10000],
  ["WD", 0x40000],
  ["WO", 0x80000],
  ["RP", 0x10],
  ["WP", 0x20],
  ["CC", 0x1],
  ["DC", 0x2],
  ["LC", 0x4],
  ["SW", 0x8],
  ["LO", 0x80],
  ["DT", 0x40],
  ["CR", 0x100],
  ["FA", 0x1f01ff],
  ["FR", 0x120089],
  ["FW", 0x120116],
  ["FX", 0x1200a0],
  ["KA", 0xf003f],
  ["KR", 0x20019],
  ["KW", 0x20006],
  ["KX", 0x20019],
]);

/** The bits that let a principal read a file's data or list a folder: read data, generic read, generic all. */
const READ_BITS = 0x1 | 0x80000000 | 0x10000000;

function parseMask(text: string): number | null {
  if (/^0x[0-9a-f]+$/i.test(text)) return Number.parseInt(text.slice(2), 16);
  if (/^[0-9]+$/.test(text)) return Number.parseInt(text, 10);
  if (text.length % 2 !== 0) return null;
  let mask = 0;
  for (let i = 0; i < text.length; i += 2) {
    const bit = RIGHTS.get(text.slice(i, i + 2).toUpperCase());
    if (bit === undefined) return null;
    mask |= bit;
  }
  return mask >>> 0;
}

/**
 * The DACL of a security descriptor in SDDL (`O:BAG:...D:PAI(A;OICI;FA;;;SY)...`), or `null` when
 * the text has no `D:` part. Only the DACL is read; the owner, the group and the audit list are not.
 */
export function parseSddl(sddl: string): Dacl | null {
  const text = sddl.trim();
  // `D:` outside every bracket opens the DACL. No SID or alias contains a colon, so a `D` before a
  // colon can only be the section mark, even right after a group SID (`...-513D:AI(...)`).
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length - 1; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && c === "D" && text[i + 1] === ":") {
      start = i + 2;
      break;
    }
  }
  if (start < 0) return null;
  let i = start;
  let flags = "";
  while (i < text.length && text[i] !== "(" && !(text[i + 1] === ":" && "OGS".includes(text[i] ?? ""))) {
    flags += text[i];
    i++;
  }
  if (flags.includes("NO_ACCESS_CONTROL")) return { protected: false, aces: null };
  const aces: Ace[] = [];
  while (i < text.length && text[i] === "(") {
    // One entry, brackets balanced: a conditional entry carries its own brackets inside.
    let level = 0;
    let end = i;
    for (; end < text.length; end++) {
      if (text[end] === "(") level++;
      else if (text[end] === ")" && --level === 0) break;
    }
    if (end >= text.length) return null;
    const [type = "", aceFlags = "", rights = "", , , sid = ""] = text.slice(i + 1, end).split(";");
    const upper = sid.trim().toUpperCase();
    aces.push({ type: type.toUpperCase(), flags: aceFlags.toUpperCase(), mask: parseMask(rights), sid: SDDL_ALIASES.get(upper) ?? upper });
    i = end + 1;
  }
  return { protected: flags.includes("P"), aces };
}

/** Allow-type entries. `D`, `OD`, `XD` deny; the audit kinds grant nothing. */
const ALLOW_TYPES = new Set(["A", "OA", "XA", "ZA"]);

/**
 * The broad principals that may read under `dacl`, as `Users (S-1-5-32-545)` labels. Empty means
 * owner-only by this module's rule. A right this parser does not know counts as read, so an odd
 * list fails the check instead of passing it.
 */
export function broadReaders(dacl: Dacl): string[] {
  if (dacl.aces === null) return [`${principalLabel("S-1-1-0")}, no access list at all`];
  const found: string[] = [];
  for (const ace of dacl.aces) {
    if (!ALLOW_TYPES.has(ace.type) || !BROAD_PRINCIPALS.has(ace.sid)) continue;
    if (ace.mask !== null && (ace.mask & READ_BITS) === 0) continue;
    const label = principalLabel(ace.sid);
    if (!found.includes(label)) found.push(label);
  }
  return found;
}

/** One entry of an `icacls /save` file: the name as icacls wrote it, and its list. */
export interface SavedAcl {
  readonly name: string;
  readonly sddl: string;
}

/**
 * The text `icacls <path> /save <file>` writes, read back: a name line, then an SDDL line, for the
 * path itself and (with `/T`) every entry below it. Blank lines are skipped.
 */
export function parseSaved(text: string): SavedAcl[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  const out: SavedAcl[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    out.push({ name: lines[i]!, sddl: lines[i + 1]! });
  }
  return out;
}

/** The SID in `whoami /user /fo csv /nh` (`"pc\pat","S-1-5-21-...-1001"`). The name half may be in any code page. */
export function parseWhoamiSid(stdout: string): string | null {
  const match = /"?(S-1-[0-9]+(?:-[0-9]+)+)"?\s*$/m.exec(stdout.trim());
  return match?.[1] ?? null;
}

// ── The seam ─────────────────────────────────────────────────────────────────

/** What a run of `icacls` or `whoami` answered. `null` from the seam when the tool would not start. */
export interface ToolRun {
  readonly code: number;
  readonly stdout: string;
}

/**
 * The three Windows tools this module runs. A seam, so every rule here is tested on Linux with
 * the real output captured on the VM, and production spawns exactly what the tests name.
 */
export interface AclTool {
  /**
   * `icacls <path> /save <temp> [/T] /C /Q`, and the file it wrote read back (UTF-16). `text` is
   * empty when icacls wrote nothing. `null` when icacls would not start.
   */
  save(path: string, tree: boolean): { code: number; text: string } | null;
  /** `icacls` with these arguments, for a repair. */
  icacls(args: readonly string[]): ToolRun | null;
  /** `whoami /user /fo csv /nh`: the SID of the user this process runs as. */
  whoami(): ToolRun | null;
}

const TOOL_TIMEOUT_MS = 15_000;

/** `C:\Windows\System32\<name>`: an absolute path, so no `icacls.exe` in the folder or on PATH is run instead. */
function system32(name: string): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  return join(root, "System32", name);
}

function runTool(argv: readonly string[]): ToolRun | null {
  try {
    const r = Bun.spawnSync([...argv], { stdout: "pipe", stderr: "pipe", timeout: TOOL_TIMEOUT_MS });
    return { code: r.exitCode ?? 124, stdout: r.stdout.toString() };
  } catch {
    return null;
  }
}

/** The real tools. Only ever called on Windows; elsewhere every call answers `null`. */
export const realAclTool: AclTool = {
  save(path, tree) {
    if (process.platform !== "win32") return null;
    // In the user's own temp folder, which the profile keeps private. The file holds the access
    // list of Collie's folders, not a secret, and is removed at once.
    const file = join(tmpdir(), `collie-acl-${randomUUID()}.txt`);
    const run = runTool([system32("icacls.exe"), path, "/save", file, ...(tree ? ["/T"] : []), "/C", "/Q"]);
    if (run === null) return null;
    let text = "";
    try {
      text = readFileSync(file).toString("utf16le");
    } catch {
      text = "";
    } finally {
      rmSync(file, { force: true });
    }
    return { code: run.code, text };
  },
  icacls(args) {
    return process.platform === "win32" ? runTool([system32("icacls.exe"), ...args]) : null;
  },
  whoami() {
    return process.platform === "win32" ? runTool([system32("whoami.exe"), "/user", "/fo", "csv", "/nh"]) : null;
  },
};

/** Everything the rules here touch outside themselves. */
export interface OwnerOnlyDeps {
  readonly acl: AclTool;
  /** What is at `path`, following links, or `null` when nothing can be read there. */
  stat(path: string): { readonly dir: boolean; readonly mode: number } | null;
  /** `mkdir -p`, with the mode POSIX applies to a folder it creates. */
  mkdir(path: string, mode: number): void;
  /**
   * Whether `path` itself is a link: a symbolic link or, on Windows, a junction (Bun's `lstat` reports
   * both as links). `false` when it cannot be read.
   */
  isLink(path: string): boolean;
  /**
   * Folders whose access list Collie must never change, nor that of any folder above them: Windows,
   * Program Files, ProgramData and the user profile. A state dir set to one of them, or to a drive
   * root, is checked and never repaired, because the repair would re-permission the whole system.
   */
  readonly systemPlaces: readonly string[];
}

export const realOwnerOnlyDeps: OwnerOnlyDeps = {
  acl: realAclTool,
  stat(path) {
    try {
      const s = statSync(path);
      return { dir: s.isDirectory(), mode: s.mode & 0o777 };
    } catch {
      return null;
    }
  },
  mkdir(path, mode) {
    mkdirSync(path, { recursive: true, mode });
  },
  isLink(path) {
    try {
      return lstatSync(path).isSymbolicLink();
    } catch {
      return false;
    }
  },
  systemPlaces: ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "USERPROFILE"]
    .map((name) => process.env[name] ?? "")
    .filter((place) => place !== ""),
};

// ── The check ────────────────────────────────────────────────────────────────

/** The check's answer. `unknown` is never treated as loose: nothing is claimed about the path. */
export type OwnerOnly =
  | { readonly state: "private" }
  | {
      readonly state: "loose";
      /** The broad principals that can read, as `Users (S-1-5-32-545)` labels. */
      readonly principals: readonly string[];
      /** The entries that let them: the path itself, its folder, or a name below a folder. */
      readonly where: readonly string[];
    }
  | { readonly state: "unknown"; readonly why: string };

/** What one `/save` read found. `protected` is the first entry's flag: the path itself. */
interface TreeRead {
  readonly verdict: OwnerOnly;
  readonly protected: boolean;
  /** The loose entries BELOW the path, as icacls names them (relative to the path's parent folder). */
  readonly looseBelow: readonly string[];
}

/**
 * Read `path` (with `/T`, everything below it too) and judge it.
 *
 * `icacls /T` FOLLOWS a junction (VM, 2026-10-02: `state\link\shared.txt` was listed through a
 * junction to a folder outside). An entry that is a link, or sits below one, is not Collie's: it is
 * left out of the verdict, so the check never blames the folder for it and the repair never resets
 * a file somewhere else on the disk. Only a loose entry is looked at, so the cost is an `lstat` per
 * folder name of a loose entry, which a healthy folder never pays.
 */
function readAcl(path: string, tree: boolean, deps: OwnerOnlyDeps, host: Host): TreeRead {
  const saved = deps.acl.save(path, tree);
  if (saved === null) return unknown("icacls did not run");
  const entries = parseSaved(saved.text);
  if (entries.length === 0) return unknown(`icacls exited ${String(saved.code)} and wrote no access list`);
  const principals: string[] = [];
  const where: string[] = [];
  const looseBelow: string[] = [];
  let unreadable = 0;
  entries.forEach((entry, index) => {
    const dacl = parseSddl(entry.sddl);
    if (dacl === null) {
      unreadable++;
      return;
    }
    const found = broadReaders(dacl);
    if (found.length === 0) return;
    if (index > 0 && throughLink(path, entry.name, deps, host)) return;
    if (index > 0) looseBelow.push(entry.name);
    where.push(entry.name);
    for (const p of found) if (!principals.includes(p)) principals.push(p);
  });
  const isProtected = parseSddl(entries[0]!.sddl)?.protected ?? false;
  // A loose entry is a fact even when another entry could not be read. With no loose entry, a
  // failed exit or an entry without a list means some of the tree went unseen: unknown.
  if (principals.length > 0) return { verdict: { state: "loose", principals, where }, protected: isProtected, looseBelow };
  if (saved.code !== 0 || unreadable > 0) return unknown(`icacls exited ${String(saved.code)}`);
  return { verdict: { state: "private" }, protected: isProtected, looseBelow: [] };
}

/**
 * Whether the entry `name` (as icacls names it below `path`: `state\link\shared.txt`) is a link or
 * sits below one. The first part is `path`'s own name, and `path` itself is never asked: a state dir
 * the operator pointed at a junction is still the state dir.
 */
function throughLink(path: string, name: string, deps: OwnerOnlyDeps, host: Host): boolean {
  const parts = name.split(/[\\/]+/).filter((part) => part !== "");
  let at = path;
  for (const part of parts.slice(1)) {
    at = host.path.join(at, part);
    if (deps.isLink(at)) return true;
  }
  return false;
}

function unknown(why: string): TreeRead {
  return { verdict: { state: "unknown", why }, protected: false, looseBelow: [] };
}

/**
 * Is `path` readable by its owner only?
 *
 * On Windows: a folder is read with everything below it (`/T`, one process), so a loose file
 * inside is found too. A file is read with its own folder, because a folder that Users can list
 * and whose new files Users inherit is not a private place for a secret. On POSIX: the mode bits,
 * 0600 or 0400 for a file and no group or other bits for a folder, as before.
 */
export function isOwnerOnly(path: string, host: Host, deps: OwnerOnlyDeps = realOwnerOnlyDeps): OwnerOnly {
  const found = deps.stat(path);
  if (host.platform !== "win32") {
    if (found === null) return { state: "unknown", why: "it cannot be read" };
    const ok = found.dir ? (found.mode & 0o077) === 0 : PRIVATE_FILE_MODES.has(found.mode);
    return ok ? { state: "private" } : { state: "loose", principals: ["group or other users"], where: [path] };
  }
  if (found === null) return { state: "unknown", why: "it cannot be read" };
  if (found.dir) return readAcl(path, true, deps, host).verdict;
  const own = readAcl(path, false, deps, host).verdict;
  const folder = readAcl(host.path.dirname(path), false, deps, host).verdict;
  return combine([
    { verdict: own, name: path },
    { verdict: folder, name: host.path.dirname(path) },
  ]);
}

/** Several answers as one: loose wins over unknown, unknown over private. */
function combine(parts: readonly { verdict: OwnerOnly; name: string }[]): OwnerOnly {
  const principals: string[] = [];
  const where: string[] = [];
  let why: string | null = null;
  for (const { verdict, name } of parts) {
    if (verdict.state === "loose") {
      for (const p of verdict.principals) if (!principals.includes(p)) principals.push(p);
      where.push(name);
    } else if (verdict.state === "unknown") {
      why ??= verdict.why;
    }
  }
  if (principals.length > 0) return { state: "loose", principals, where };
  if (why !== null) return { state: "unknown", why };
  return { state: "private" };
}

// ── The repair ───────────────────────────────────────────────────────────────

const BROAD_ARGS = [...BROAD_PRINCIPALS.keys()].map((sid) => `*${sid}`);

/**
 * The `icacls` arguments that make `path` owner-only: nothing inherited from the parent, full
 * control for the user, SYSTEM and Administrators (inherited by every child of a folder), and every
 * grant to a broad principal taken out. One process; Windows passes the new list down to the
 * children that inherit (measured on the VM: 2000 files in 81 ms).
 */
export function ownerOnlyArgs(path: string, userSid: string, folder: boolean): string[] {
  const inherit = folder ? "(OI)(CI)" : "";
  return [
    path,
    "/inheritance:r",
    "/grant:r",
    `*${userSid}:${inherit}F`,
    `*${SYSTEM_SID}:${inherit}F`,
    `*${ADMINISTRATORS_SID}:${inherit}F`,
    "/remove:g",
    ...BROAD_ARGS,
    "/Q",
  ];
}

/**
 * The same repair as one line an operator can paste into PowerShell or cmd. The grants are quoted
 * because PowerShell reads a bare `(OI)` as an expression.
 */
export function ownerOnlyCommand(path: string, userSid: string | null, folder: boolean): string {
  const args = ownerOnlyArgs(path, userSid ?? "<your SID from whoami /user>", folder).slice(0, -1);
  return `icacls ${args.map((a) => (/[\s()]/.test(a) || a === path ? `"${a}"` : a)).join(" ")}`;
}

/** The SID of the user this process runs as, or `null`. */
export function currentUserSid(acl: AclTool): string | null {
  const run = acl.whoami();
  return run === null || run.code !== 0 ? null : parseWhoamiSid(run.stdout);
}

/** What {@link ensureOwnerOnlyDir} did. */
export type DirOutcome =
  /** Owner-only already, with its own protected list. Nothing was changed. */
  | { readonly state: "private" }
  /** Changed, and a second read confirmed it. `was` names who could read before (may be empty). */
  | { readonly state: "made-private"; readonly was: readonly string[] }
  /** Still readable by `principals` after the repair, or the repair could not run. */
  | { readonly state: "loose"; readonly principals: readonly string[]; readonly why: string }
  | { readonly state: "unknown"; readonly why: string };

/**
 * Create `path` if needed and make it a private folder.
 *
 * POSIX: `mkdir -p` with mode 0700, and nothing else, exactly what the bridge did before. Returns
 * `null`, because nothing was checked.
 *
 * Windows: one read of the folder and everything below it. When the folder already has its own
 * protected list and nobody broad can read anything in it, that read is the whole cost. Otherwise:
 * the user's SID (`whoami`), the folder's list set ({@link ownerOnlyArgs}), which Windows passes down
 * to every entry that inherits, and a second read. An entry still loose after that has a grant or a
 * list of its own, and only that entry is reset to inherit (`icacls <entry> /reset`), never the
 * whole tree, so a hand-made exception elsewhere in the folder stays. Then one last read. The answer
 * says `made-private` ONLY when the last read passes.
 *
 * A drive root, or a folder that is or holds Windows, Program Files, ProgramData or the user profile
 * ({@link OwnerOnlyDeps.systemPlaces}), is read and never changed.
 */
export function ensureOwnerOnlyDir(
  path: string,
  host: Host,
  deps: OwnerOnlyDeps = realOwnerOnlyDeps,
): DirOutcome | null {
  deps.mkdir(path, 0o700);
  if (host.platform !== "win32") return null;
  const before = readAcl(path, true, deps, host);
  if (before.verdict.state === "unknown") return before.verdict;
  if (before.verdict.state === "private" && before.protected) return { state: "private" };
  const was = before.verdict.state === "loose" ? before.verdict.principals : [];
  if (isSystemPlace(path, host, deps.systemPlaces)) {
    if (before.verdict.state === "private") return { state: "private" };
    return { state: "loose", principals: was, why: "it is a drive root or holds a system or profile folder, which Collie never changes" };
  }
  const sid = currentUserSid(deps.acl);
  if (sid === null) {
    return { state: "loose", principals: was, why: "whoami did not name the user this process runs as" };
  }
  const set = deps.acl.icacls(ownerOnlyArgs(path, sid, true));
  if (set === null || set.code !== 0) {
    return { state: "loose", principals: was, why: `icacls exited ${set === null ? "before it started" : String(set.code)}` };
  }
  let after = readAcl(path, true, deps, host);
  if (after.looseBelow.length > 0) {
    const parent = host.path.dirname(path);
    for (const name of after.looseBelow) deps.acl.icacls([host.path.join(parent, name), "/reset", "/C", "/Q"]);
    after = readAcl(path, true, deps, host);
  }
  if (after.verdict.state === "private" && after.protected) return { state: "made-private", was };
  if (after.verdict.state === "loose") return { state: "loose", principals: after.verdict.principals, why: "it is still readable after the repair" };
  return { state: "unknown", why: after.verdict.state === "unknown" ? after.verdict.why : "the list is not protected after the repair" };
}

/** A drive root, or a folder that is one of `places` or holds one of them. */
function isSystemPlace(path: string, host: Host, places: readonly string[]): boolean {
  const { root, parts } = splitPath(host, path);
  if (parts.length === 0 && root !== "") return true;
  return places.some((place) => isInside(host, place, path));
}

/**
 * The one line the bridge prints for {@link ensureOwnerOnlyDir}'s answer, or `null` when there is
 * nothing to say. Never "made it owner-only" unless the second read confirmed it.
 */
export function dirOutcomeLine(path: string, outcome: DirOutcome | null, sid: string | null = null): string | null {
  if (outcome === null || outcome.state === "private") return null;
  switch (outcome.state) {
    case "made-private":
      return outcome.was.length > 0
        ? `[secrets] ${path} was readable by ${outcome.was.join(", ")}; made it owner-only.`
        : `[secrets] made ${path} owner-only: only you, SYSTEM and Administrators can open it.`;
    case "loose":
      return (
        `[secrets] ${path} could not be made owner-only (${outcome.why})` +
        (outcome.principals.length > 0 ? `; ${outcome.principals.join(", ")} can read it` : "") +
        `. Fix it with: ${ownerOnlyCommand(path, sid, true)}`
      );
    case "unknown":
      return `[secrets] could not read the access list of ${path} (${outcome.why}); Collie cannot say who can read it.`;
  }
}

// ── A secret file outside the private folders ────────────────────────────────

/** Paths this process already said "cannot say" about. Once each, never a line per read. */
const toldUnknown = new Set<string>();

/**
 * The Windows rule for ONE secret file, in the shape the config loader takes from the POSIX mode
 * rule (`bridge/config-source.ts`'s {@link PrivateFileVerdict}): `ok` is false only when the file is
 * loose AND the repair did not take, and the caller withholds exactly what it withholds on POSIX.
 *
 * The file's own list decides, not its folder's: the file is what holds the secret, and a file that
 * sits outside Collie's folders (`~/.collie/config.toml`) is checked and repaired where it is, never
 * moved, and its folder is left alone. The repair is a file-level {@link ownerOnlyArgs}; the line
 * says "made it owner-only" only when a second read passes.
 */
export function secretFileVerdict(path: string, deps: OwnerOnlyDeps = realOwnerOnlyDeps): PrivateFileVerdict {
  // One file, never `/T`: there is nothing below it, so no link can be crossed.
  const before = readAcl(path, false, deps, WINDOWS).verdict;
  if (before.state === "private") return { ok: true, warning: null };
  if (before.state === "unknown") {
    if (toldUnknown.has(path)) return { ok: true, warning: null };
    toldUnknown.add(path);
    return {
      ok: true,
      warning: `note: could not read the access list of ${path} (${before.why}); Collie cannot say who can read it.`,
    };
  }
  const who = before.principals.join(", ");
  const sid = currentUserSid(deps.acl);
  const set = sid === null ? null : deps.acl.icacls(ownerOnlyArgs(path, sid, false));
  const after = set !== null && set.code === 0 ? readAcl(path, false, deps, WINDOWS).verdict : before;
  if (after.state === "private") {
    return { ok: true, warning: `warn: ${path} was readable by ${who}; made it owner-only.` };
  }
  return {
    ok: false,
    warning:
      `warn: ${path} is readable by ${who} and could not be made owner-only; other users may read it. ` +
      `Fix it with: ${ownerOnlyCommand(path, sid, false)}`,
  };
}

/** For tests: forget which paths were already reported as unreadable. */
export function forgetUnknownNotes(): void {
  toldUnknown.clear();
}
