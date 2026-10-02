// PRIVATE TO YOUR ACCOUNT: WHO MAY READ COLLIE'S SECRETS, ON EVERY HOST (M43 spec 04).
//
// The trust store, the pairing registry, push subscriptions, the VAPID key in `.env` and the rest
// must be readable by the account that runs Collie only. On Linux and macOS the mode bits say that
// (files 0600, folders 0700), and nothing here changes how. NTFS has no mode bits: `stat` reports
// 666 or 777 and `chmod` flips only the read-only flag, so on Windows the guarantee comes from the
// access list, and this module is the one door to it. The callers import from here only:
//
//   `sddl.ts`        the text of an access list, and the allowlist rule (pure)
//   `acl-policy.ts`  what Collie may change and what it only looks at (pure)
//   `icacls.ts`      the Windows tools, by absolute path, bounded
//
// THE THREE ANSWERS. A path is `private`, `loose` (a VERIFIED grant to someone outside the
// allowlist, with who and what), or `not-checked` (with the reason: a link, a network share, no
// access list, a tool that failed or ran out of time). Only `loose` is ever reported as a leak, and
// only `loose` can make the config loader withhold a secret.
//
// THE REPAIR runs in the bridge process at start and nowhere else (a CLI command only verifies and
// warns), only on a folder `acl-policy.ts` calls Collie's own, and never with `/T`. It changes the
// folder in ONE `icacls` call, grants first and the end of inheritance after (so the list is never
// empty for a moment: proven on the VM with a reader in another process, 0 failed reads), then
// resets to "inherit" only the entries a second check still finds loose, after a fresh `lstat` of
// each (no link, no hard link). The old lists are saved first, and the line to put them back is
// printed. Not `icacls /restore` for the change: it needs the Restore privilege, which a standard
// user does not hold (VM, 2026-10-02: error 1300). `COLLIE_NO_ACL_REPAIR=1` turns every change off; the check
// still runs and still warns.

import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

import {
  defaultLocations,
  isNetworkPath,
  type PrivateRoot,
  repairScope,
  type EntryKind,
  type Scope,
  systemPlaces,
} from "./acl-policy.ts";
import { PRIVATE_FILE_MODES, type PrivateFileVerdict } from "./config-source.ts";
import { type Host, hostFor } from "./host.ts";
import { type AclTool, aclTool } from "./icacls.ts";
import {
  ADMINISTRATORS_SID,
  foreignGrants,
  foreignOwner,
  parseSaved,
  parseSddl,
  parseWhoamiSid,
  formatSaved,
  type SavedAcl,
  sidName,
  SYSTEM_SID,
} from "./sddl.ts";

export { PRIVATE_ROOTS, privateRoot, type PrivateRoot } from "./acl-policy.ts";

/** The host the Windows-only entry points read paths with. */
const WINDOWS = hostFor("win32");

/** The off switch. The check still runs and still warns; nothing is changed. */
export const NO_ACL_REPAIR_ENV = "COLLIE_NO_ACL_REPAIR";

/** May this process change an access list at all? `COLLIE_NO_ACL_REPAIR=1` says no. */
export function aclRepairAllowed(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[NO_ACL_REPAIR_ENV] !== "1";
}

// ── The seams ────────────────────────────────────────────────────────────────

/** Everything the rules touch outside themselves. Production passes {@link realOwnerOnlyDeps}. */
export interface OwnerOnlyDeps {
  readonly acl: AclTool;
  /** What is at `path`, links followed, or `null` when nothing can be read there. */
  stat(path: string): { readonly dir: boolean; readonly mode: number; readonly nlink: number } | null;
  /** Whether `path` itself is a link (a symbolic link or a junction). `false` when it cannot be read. */
  isLink(path: string): boolean;
  /** The real path: links, 8.3 names and `\\?\` resolved. `null` when it cannot be resolved. */
  realpath(path: string): string | null;
  /** The names in a folder, or `null` when it cannot be listed. */
  list(path: string): string[] | null;
  /** `mkdir -p`, with the mode POSIX applies to a folder it creates. */
  mkdir(path: string, mode: number): void;
  /** Write a backup file (UTF-16, the `icacls /save` format) and remove an old one. */
  writeBackup(path: string, text: string): boolean;
  removeFile(path: string): void;
  /** The environment the places and default locations come from, and the user's home. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  now(): number;
}

export const realOwnerOnlyDeps: OwnerOnlyDeps = {
  acl: aclTool(),
  stat(path) {
    try {
      const s = statSync(path);
      return { dir: s.isDirectory(), mode: s.mode & 0o777, nlink: s.nlink };
    } catch {
      return null;
    }
  },
  isLink(path) {
    try {
      return lstatSync(path).isSymbolicLink();
    } catch {
      return false;
    }
  },
  realpath(path) {
    try {
      return realpathSync.native(path);
    } catch {
      return null;
    }
  },
  list(path) {
    try {
      return readdirSync(path);
    } catch {
      return null;
    }
  },
  mkdir(path, mode) {
    mkdirSync(path, { recursive: true, mode });
  },
  writeBackup(path, text) {
    try {
      writeFileSync(path, Buffer.from(text, "utf16le"));
      return true;
    } catch {
      return false;
    }
  },
  removeFile(path) {
    rmSync(path, { force: true });
  },
  env: process.env,
  home: homedir(),
  now: () => Date.now(),
};

/** The account that runs Collie, by SID, asked of `whoami` once per tool. */
const users = new WeakMap<AclTool, string | null>();

export function currentUserSid(acl: AclTool): string | null {
  if (!users.has(acl)) {
    const run = acl.whoami();
    users.set(acl, run === null || run.timedOut || run.code !== 0 ? null : parseWhoamiSid(run.stdout));
  }
  return users.get(acl) ?? null;
}

// ── The check ────────────────────────────────────────────────────────────────

/** One grant outside the allowlist: on which path, to whom, and what it allows. */
export interface Leak {
  readonly path: string;
  readonly sid: string;
  readonly what: string;
}

/** The check's answer. Only `loose` is a verified leak. */
export type OwnerOnly =
  | { readonly state: "private" }
  | { readonly state: "loose"; readonly leaks: readonly Leak[] }
  | { readonly state: "not-checked"; readonly reason: string };

/** One read, as the repair needs it: the verdict, the folder's protection, the loose entries. */
interface Reading {
  readonly verdict: OwnerOnly;
  readonly protected: boolean;
  /** Loose paths below the folder read, in full. */
  readonly looseBelow: readonly string[];
}

const notChecked = (reason: string): Reading => ({ verdict: { state: "not-checked", reason }, protected: false, looseBelow: [] });

/**
 * Read `path` with `icacls /save` (with `/T`, everything below it too) and judge it.
 *
 * `/T` FOLLOWS a junction (VM, 2026-10-02: `state\link\shared.txt` was listed through a junction to
 * a folder outside). An entry that is a link, or sits below one, is not Collie's: it is left out,
 * so the check never blames the folder for it and the repair never touches it.
 */
function readPath(path: string, tree: boolean, host: Host, deps: OwnerOnlyDeps): Reading {
  if (isNetworkPath(path)) return notChecked("it is on a network share, whose own share permissions Collie cannot read");
  const user = currentUserSid(deps.acl);
  if (user === null) return notChecked("whoami did not name the account that runs Collie");
  const saved = deps.acl.save(path, tree);
  if (saved.kind === "timed-out") return notChecked("icacls did not answer within 10 seconds");
  if (saved.kind === "not-run") return notChecked("icacls did not start");
  const entries = parseSaved(saved.text);
  if (entries.length === 0) {
    return notChecked(`icacls found no access list (exit ${String(saved.code)}); FAT, exFAT and network drives have none`);
  }
  const leaks: Leak[] = [];
  const looseBelow: string[] = [];
  let unreadable = 0;
  const parent = host.path.dirname(path);
  entries.forEach((entry, index) => {
    const dacl = parseSddl(entry.sddl).dacl;
    if (dacl === null) {
      unreadable++;
      return;
    }
    const grants = foreignGrants(dacl, user);
    if (grants.length === 0) return;
    if (index > 0 && throughLink(path, entry.name, host, deps)) return;
    const full = index === 0 ? path : host.path.join(parent, entry.name);
    if (index > 0) looseBelow.push(full);
    for (const g of grants) leaks.push({ path: full, sid: g.sid, what: g.what });
  });
  const isProtected = parseSddl(entries[0]!.sddl).dacl?.protected ?? false;
  // A loose entry is a fact even when another entry could not be read. With none, a failed exit or
  // an entry without a list means some of it went unseen: not checked, never "private".
  if (leaks.length > 0) return { verdict: { state: "loose", leaks }, protected: isProtected, looseBelow };
  if (saved.code !== 0 || unreadable > 0) return notChecked(`icacls could not read all of it (exit ${String(saved.code)})`);
  return { verdict: { state: "private" }, protected: isProtected, looseBelow: [] };
}

/**
 * Whether the entry `name` (as icacls names it below `path`: `state\link\shared.txt`) is a link or
 * sits below one. `path` itself is never asked: a state dir pointed at a junction is still the state dir.
 */
function throughLink(path: string, name: string, host: Host, deps: OwnerOnlyDeps): boolean {
  let at = path;
  for (const part of name.split(/[\\/]+/).filter((p) => p !== "").slice(1)) {
    at = host.path.join(at, part);
    if (deps.isLink(at)) return true;
  }
  return false;
}

/** Several readings as one: loose wins, then not-checked, then private. */
function combine(readings: readonly OwnerOnly[]): OwnerOnly {
  const leaks = readings.flatMap((r) => (r.state === "loose" ? r.leaks : []));
  if (leaks.length > 0) return { state: "loose", leaks };
  const skipped = readings.find((r) => r.state === "not-checked");
  return skipped ?? { state: "private" };
}

/**
 * Is `path` private to the account that runs Collie?
 *
 * Windows: a folder is read with everything below it (`/T`, one process; `collie doctor`'s full
 * scan). A file is read with its own folder, because a folder other accounts can list and whose
 * new files they inherit is not a private place for a secret. POSIX: the mode bits, 0600 or 0400
 * for a file and no group or other bits for a folder, as before.
 */
export function isOwnerOnly(path: string, host: Host, deps: OwnerOnlyDeps = realOwnerOnlyDeps): OwnerOnly {
  const found = deps.stat(path);
  if (found === null) return { state: "not-checked", reason: "it cannot be read" };
  if (host.platform !== "win32") {
    const ok = found.dir ? (found.mode & 0o077) === 0 : PRIVATE_FILE_MODES.has(found.mode);
    return ok ? { state: "private" } : { state: "loose", leaks: [{ path, sid: "group or other", what: "read" }] };
  }
  if (found.dir) return readPath(path, true, host, deps).verdict;
  return combine([readPath(path, false, host, deps).verdict, readPath(host.path.dirname(path), false, host, deps).verdict]);
}

/**
 * The owner of each path when it is someone outside the allowlist: an owner keeps WRITE_DAC, so it
 * can open the list again whatever the list says, and no repair here can change an owner. One
 * PowerShell for all of them (icacls never writes the owner); `collie doctor` alone pays for it.
 */
export function foreignOwners(paths: readonly string[], deps: OwnerOnlyDeps = realOwnerOnlyDeps): Map<string, string> {
  const user = currentUserSid(deps.acl);
  const out = new Map<string, string>();
  const read = user === null ? null : deps.acl.descriptors(paths);
  if (read === null || user === null) return out;
  for (const [path, sddl] of read) {
    const owner = foreignOwner(parseSddl(sddl), user);
    if (owner !== null) out.set(path, owner);
  }
  return out;
}

// ── Words ────────────────────────────────────────────────────────────────────

/** `Users [S-1-5-32-545], Everyone [S-1-1-0]`: names for the sentence, each SID once in brackets. */
export function whoCanRead(leaks: readonly Leak[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of leaks) {
    if (seen.has(l.sid)) continue;
    seen.add(l.sid);
    out.push(l.sid.startsWith("S-") ? `${sidName(l.sid)} [${l.sid}]` : sidName(l.sid));
  }
  return out.join(", ");
}

/**
 * The repair, as `icacls` arguments: the three grants first, then the end of inheritance, then every
 * named stranger removed, in ONE call. The account and the strangers by SID, so no name in any
 * language can break it. A domain alias with no fixed SID (`DU`) cannot be named on a command line;
 * `/inheritance:r` still drops it when it was inherited, and the second check names it otherwise.
 */
export function privateArgs(path: string, userSid: string, folder: boolean, leaks: readonly Leak[] = []): string[] {
  const inherit = folder ? "(OI)(CI)" : "";
  const grants = [userSid, SYSTEM_SID, ADMINISTRATORS_SID].map((sid) => `*${sid}:${inherit}F`);
  const strangers = [...new Set(leaks.map((l) => l.sid).filter((sid) => sid.startsWith("S-")))].map((sid) => `*${sid}`);
  return [path, "/grant:r", ...grants, "/inheritance:r", ...(strangers.length > 0 ? ["/remove:g", ...strangers] : [])];
}

/**
 * The same repair as one line an operator can paste into PowerShell or cmd: the path and the grants
 * quoted (PowerShell reads a bare `(OI)` as an expression), no placeholder.
 */
export function privateCommand(path: string, userSid: string, folder: boolean, leaks: readonly Leak[] = []): string {
  const [first, ...rest] = privateArgs(path, userSid, folder, leaks);
  return `icacls "${first!}" ${rest.map((a) => (a.includes("(") ? `"${a}"` : a.startsWith("*S-") && a.includes(":") ? `"${a}"` : a)).join(" ")}`;
}

/** Run the repair. `null` when it went through, else why not. */
function applyPrivate(path: string, user: string, folder: boolean, leaks: readonly Leak[], deps: OwnerOnlyDeps): string | null {
  const run = deps.acl.icacls([...privateArgs(path, user, folder, leaks), "/C", "/Q"]);
  if (run === null) return "icacls did not start";
  if (run.timedOut) return "icacls did not answer within 10 seconds";
  return run.code === 0 ? null : `icacls exited ${String(run.code)}`;
}

/** Saved lists waiting for the state folder: `/restore` takes one parent per file. */
const pendingBackups = new Map<string, SavedAcl[]>();

/** Save `path`'s current list (no `/T`) under `parent`, named relative to it, before it changes. */
function backUp(path: string, parent: string, host: Host, deps: OwnerOnlyDeps): void {
  const saved = deps.acl.save(path, false);
  if (saved.kind !== "ok") return;
  const entry = parseSaved(saved.text)[0];
  if (entry === undefined) return;
  const name = host.path.relative(parent, path);
  const list = pendingBackups.get(parent) ?? [];
  list.push({ name, sddl: entry.sddl });
  pendingBackups.set(parent, list);
}

/** How many runs of backups are kept. */
const BACKUP_RUNS = 3;

/** The state folder's subfolder the saved lists go to (Windows only, created on the first repair). */
export const ACL_BACKUPS = "acl-backups";

/**
 * Write the saved lists into `<stateDir>\acl-backups` as `acl-backup-<time>-<n>.sddl`, one file
 * per parent (`/restore` takes one), keep the last {@link BACKUP_RUNS} runs, and return the lines
 * that say how to put each one back. The folder sits inside the state folder, so it is private.
 */
export function flushAclBackups(stateDir: string, host: Host = WINDOWS, deps: OwnerOnlyDeps = realOwnerOnlyDeps): string[] {
  if (pendingBackups.size === 0) return [];
  const folder = host.path.join(stateDir, ACL_BACKUPS);
  deps.mkdir(folder, 0o700);
  const stamp = new Date(deps.now()).toISOString().replace(/[:.]/g, "-");
  const lines: string[] = [];
  let n = 0;
  for (const [parent, entries] of pendingBackups) {
    const file = host.path.join(folder, `acl-backup-${stamp}-${String(++n)}.sddl`);
    const text = formatSaved(entries);
    if (deps.writeBackup(file, text)) {
      // `/restore` needs the Restore privilege: an administrator's terminal, for any account.
      lines.push(`[secrets] the old permissions are saved. To put them back, in a terminal run as administrator: icacls "${parent}" /restore "${file}"`);
    }
  }
  pendingBackups.clear();
  const names = deps.list(folder) ?? [];
  const runs = [...new Set(names.flatMap((name) => /^acl-backup-(.+)-\d+\.sddl$/.exec(name)?.slice(1, 2) ?? []))].toSorted();
  for (const old of runs.slice(0, Math.max(0, runs.length - BACKUP_RUNS))) {
    for (const name of names) if (name.startsWith(`acl-backup-${old}-`)) deps.removeFile(host.path.join(folder, name));
  }
  return lines;
}

/** For tests: forget saved lists and the cached account. */
export function resetOwnerOnlyState(): void {
  pendingBackups.clear();
  toldNotChecked.clear();
}

/**
 * Re-check one entry right before it is reset: it must still be inside `dir` with no link on the
 * way, not be a link itself, and not be a hard link (a second name would carry the change to a file
 * somewhere else). The window between the check and the change is the one a swap would use.
 */
function safeToReset(entry: string, dir: string, host: Host, deps: OwnerOnlyDeps): boolean {
  const rel = host.path.relative(dir, entry);
  if (rel === "" || rel.startsWith("..") || host.path.isAbsolute(rel)) return false;
  let at = dir;
  for (const part of rel.split(/[\\/]+/)) {
    at = host.path.join(at, part);
    if (deps.isLink(at)) return false;
  }
  const s = deps.stat(entry);
  return s !== null && (s.dir || s.nlink <= 1);
}

/** What one secured folder came to. */
export type DirOutcome =
  /** Private already, with its own protected list. Nothing was changed. */
  | { readonly state: "private" }
  /** Changed, and a second check confirmed it. `removed` names who could read before (may be empty). */
  | { readonly state: "made-private"; readonly removed: readonly Leak[] }
  /** Loose, and not changed: Collie may not change it, or the switch is off. */
  | { readonly state: "left-loose"; readonly leaks: readonly Leak[]; readonly why: string }
  /** Loose after an attempt to repair it. */
  | { readonly state: "repair-failed"; readonly leaks: readonly Leak[]; readonly why: string }
  | { readonly state: "not-checked"; readonly reason: string };

/** The start-up read: the folder itself and the secret files of its root that exist, never `/T`. */
function readRoot(dir: string, root: PrivateRoot, host: Host, deps: OwnerOnlyDeps): Reading {
  const self = readPath(dir, false, host, deps);
  const files = root.secrets.map((name) => host.path.join(dir, name)).filter((p) => deps.stat(p) !== null);
  const readings = [self, ...files.map((f) => readPath(f, false, host, deps))];
  const verdict = combine(readings.map((r) => r.verdict));
  const looseBelow = files.filter((_, i) => readings[i + 1]!.verdict.state === "loose");
  return { verdict, protected: self.protected, looseBelow };
}

/** The facts {@link repairScope} needs about `dir`. */
export function scopeOf(dir: string, createdNow: boolean, host: Host, deps: OwnerOnlyDeps): Scope {
  const places = systemPlaces(deps.env, (p) => deps.realpath(p));
  const defaults = defaultLocations(host, deps.env, deps.home).map((d) => ({ parent: deps.realpath(d.parent) ?? d.parent, prefix: d.prefix }));
  const look = (rel: readonly string[]): EntryKind | null => {
    const path = host.path.join(dir, ...rel);
    if (deps.isLink(path)) return { kind: "link" };
    const found = deps.stat(path);
    if (found === null) return null;
    return found.dir ? { kind: "folder", names: deps.list(path) } : { kind: "file" };
  };
  return repairScope({ realPath: deps.realpath(dir), createdNow, names: deps.list(dir), look }, host, places, defaults);
}

/**
 * Make one private root private, at bridge start.
 *
 * POSIX: `mkdir -p` with mode 0700 and nothing else, as before; returns `null`, nothing checked.
 *
 * Windows: read the folder and its secret files (one `icacls` each, no `/T`). Private and protected:
 * done. Otherwise, when `repair` is on and {@link scopeOf} allows it: save the old lists, change the
 * folder in one grant-first `icacls` call ({@link privateArgs}), read again, reset each secret file a fresh `lstat`
 * still clears ({@link safeToReset}), read a last time. `made-private` only when that last read
 * passes. When Collie may not change it, `left-loose` with the reason, and nothing changed.
 */
export function ensureOwnerOnlyDir(
  dir: string,
  host: Host,
  opts: { readonly root: PrivateRoot; readonly repair: boolean; readonly createdNow?: boolean },
  deps: OwnerOnlyDeps = realOwnerOnlyDeps,
): DirOutcome | null {
  deps.mkdir(dir, 0o700);
  if (host.platform !== "win32") return null;
  const before = readRoot(dir, opts.root, host, deps);
  if (before.verdict.state === "not-checked") return before.verdict;
  if (before.verdict.state === "private" && before.protected) return { state: "private" };
  const leaks = before.verdict.state === "loose" ? before.verdict.leaks : [];
  if (!opts.repair) {
    if (leaks.length === 0) return { state: "private" };
    return { state: "left-loose", leaks, why: `${NO_ACL_REPAIR_ENV}=1 is set` };
  }
  const scope = scopeOf(dir, opts.createdNow === true, host, deps);
  if (!scope.allowed) {
    if (leaks.length === 0) return { state: "private" };
    return { state: "left-loose", leaks, why: scope.why };
  }
  const user = currentUserSid(deps.acl);
  if (user === null) return { state: "not-checked", reason: "whoami did not name the account that runs Collie" };
  const parent = host.path.dirname(dir);
  if (opts.createdNow !== true) {
    backUp(dir, parent, host, deps);
    for (const entry of before.looseBelow) backUp(entry, parent, host, deps);
  }
  const failed = applyPrivate(dir, user, true, leaks, deps);
  if (failed !== null) return { state: "repair-failed", leaks, why: failed };
  let after = readRoot(dir, opts.root, host, deps);
  if (after.looseBelow.length > 0) {
    for (const entry of after.looseBelow) if (safeToReset(entry, dir, host, deps)) deps.acl.reset(entry);
    after = readRoot(dir, opts.root, host, deps);
  }
  if (after.verdict.state === "private" && after.protected) return { state: "made-private", removed: leaks };
  if (after.verdict.state === "loose") return { state: "repair-failed", leaks: after.verdict.leaks, why: "it is still open after the repair" };
  return { state: "not-checked", reason: after.verdict.state === "not-checked" ? after.verdict.reason : "its list is not protected after the repair" };
}

/**
 * A folder Collie creates now (the CLI's `mkdirp(..., 0o700)` before any bridge ran): give it the
 * private list at birth. Not a repair: nothing existed, so nothing is saved or reported. Off with
 * the switch, and a no-op off Windows.
 */
export function createPrivateDir(dir: string, host: Host, deps: OwnerOnlyDeps = realOwnerOnlyDeps): void {
  deps.mkdir(dir, 0o700);
  if (host.platform !== "win32" || !aclRepairAllowed(deps.env)) return;
  const user = currentUserSid(deps.acl);
  if (user === null) return;
  applyPrivate(dir, user, true, [], deps);
}

/** The line the bridge prints for an outcome, or `null` when there is nothing to say. */
export function dirOutcomeLine(dir: string, outcome: DirOutcome | null, deps: OwnerOnlyDeps = realOwnerOnlyDeps): string | null {
  if (outcome === null || outcome.state === "private") return null;
  const user = currentUserSid(deps.acl);
  switch (outcome.state) {
    case "made-private":
      return outcome.removed.length > 0
        ? `[secrets] ${dir} could be read by other accounts on this PC (${whoCanRead(outcome.removed)}). ` +
            "Collie restricted it to your account, SYSTEM and Administrators. Nothing for you to do. If this repeats on " +
            "every start, something resets the permissions (a backup restore, a sync tool, antivirus)."
        : `[secrets] ${dir} now keeps its own permissions: your account, SYSTEM and Administrators. Nothing for you to do.`;
    case "left-loose":
      return (
        `[secrets] ${dir} can be read by other accounts on this PC (${whoCanRead(outcome.leaks)}). ` +
        `Collie did not change it, because ${outcome.why}.` +
        (user === null ? "" : ` To make it private, run: ${privateCommand(dir, user, true, outcome.leaks)}`)
      );
    case "repair-failed":
      return (
        `[secrets] could not make ${dir} private (${outcome.why}). Other accounts on this PC (${whoCanRead(outcome.leaks)}) can still read it.` +
        (user === null ? " Restart Collie to try again." : ` Fix: ${privateCommand(dir, user, true, outcome.leaks)}, then restart Collie.`)
      );
    case "not-checked":
      return `[secrets] cannot confirm who can read ${dir}: ${outcome.reason}.`;
  }
}

// ── One secret file, for the config loader ───────────────────────────────────

/** Paths this process already said "cannot confirm" about. Once each, never a line per read. */
const toldNotChecked = new Set<string>();

/**
 * The Windows rule for ONE secret file (`.env`, `config.toml`), in the shape the config loader takes
 * from the POSIX mode rule (`config-source.ts`'s {@link PrivateFileVerdict}).
 *
 * The file's own list decides. Not checked: no claim, said once, and the secret is used. Loose and
 * `repair` off (every CLI command): a warning that says how to fix it, and `ok: false`, so the
 * loader withholds a `config.toml` secret exactly as POSIX does for a file it could not tighten.
 * Loose and `repair` on (the bridge at start), when the file's folder is Collie's own and the file is
 * neither a link nor a hard link ({@link safeToReset}): the old list saved, the file changed in one
 * grant-first call, and "private" said only when a second read passes.
 */
export function secretFileVerdict(
  path: string,
  opts: { readonly repair: boolean },
  deps: OwnerOnlyDeps = realOwnerOnlyDeps,
): PrivateFileVerdict {
  const host = WINDOWS;
  const before = readPath(path, false, host, deps).verdict;
  if (before.state === "private") return { ok: true, warning: null };
  if (before.state === "not-checked") {
    if (toldNotChecked.has(path)) return { ok: true, warning: null };
    toldNotChecked.add(path);
    return { ok: true, warning: `note: cannot confirm who can read ${path}: ${before.reason}.` };
  }
  const who = whoCanRead(before.leaks);
  const user = currentUserSid(deps.acl);
  const fix = user === null ? "" : privateCommand(path, user, false, before.leaks);
  const folder = host.path.dirname(path);
  const scope = opts.repair && aclRepairAllowed(deps.env) ? scopeOf(folder, false, host, deps) : null;
  if (scope === null || !scope.allowed || user === null) {
    const reason =
      scope === null ? "Restart Collie to repair it" : `Collie did not change it, because ${scope.allowed ? "whoami did not answer" : scope.why}. Fix it yourself`;
    return { ok: false, warning: `warn: ${path} can be read by other accounts on this PC (${who}). ${reason}, or run: ${fix}` };
  }
  // The folder's scope says nothing about the file itself. A link, or a file with a second name (a
  // hard link needs no privilege), would carry the new list to a file somewhere else: the same fresh
  // `lstat` the folder repair runs before it resets an entry, run right before this change.
  if (!safeToReset(path, folder, host, deps)) {
    return {
      ok: false,
      warning:
        `warn: ${path} can be read by other accounts on this PC (${who}). Collie did not change it, because it is a link or has ` +
        `a second name (a hard link), so the change would reach a file elsewhere. Fix it yourself, or run: ${fix}`,
    };
  }
  backUp(path, folder, host, deps);
  const after = applyPrivate(path, user, false, before.leaks, deps) === null ? readPath(path, false, host, deps).verdict : before;
  if (after.state === "private") {
    return {
      ok: true,
      warning: `warn: ${path} could be read by other accounts on this PC (${who}). Collie restricted it to your account, SYSTEM and Administrators.`,
    };
  }
  return {
    ok: false,
    warning: `warn: could not make ${path} private. Collie did not load the secrets in it. Fix: ${fix}, then restart Collie.`,
  };
}
