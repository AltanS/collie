// SDDL: THE WINDOWS ACCESS LIST AS TEXT, AND WHO IT LETS IN (M43 spec 04).
//
// Pure. No process, no file, no host: a string goes in, facts come out. `icacls /save` writes this
// text (UTF-16, one name line and one SDDL line per entry) and PowerShell's `Get-Acl` writes the
// same grammar with the owner in front. Principals are SIDs or two-letter aliases, never names, so
// the system language does not matter: a German Windows says `Jeder` in `icacls`'s plain output and
// `WD` here.
//
// THE RULE IS AN ALLOWLIST. An allow entry for any principal outside the allowed set makes a path
// loose, whatever the right, unless the right is only SYNCHRONIZE or READ_ATTRIBUTES (both say
// nothing about the content). The allowed set:
//
//   - the account that runs Collie (its SID comes from `whoami`, outside this module),
//   - SYSTEM (S-1-5-18) and the local Administrators group (S-1-5-32-544), which a Windows user
//     profile already grants: backup, search and antivirus run as SYSTEM, and an administrator can
//     take any file anyway,
//   - CREATOR OWNER (S-1-3-0) and OWNER RIGHTS (S-1-3-4), placeholders for the owner itself,
//   - TrustedInstaller, the service that owns system files.
//
// A deny entry is never a leak. Object and conditional allow entries (`OA`, `XA`, `ZA`) count like
// `A`. An inherit-only entry (`IO`) does not apply to the folder itself, but a folder passes it to
// every new file (`OI`) or folder (`CI`), so it counts there and is named "for new files".

// ── Principals ───────────────────────────────────────────────────────────────

export const SYSTEM_SID = "S-1-5-18";
export const ADMINISTRATORS_SID = "S-1-5-32-544";
export const CREATOR_OWNER_SID = "S-1-3-0";
export const OWNER_RIGHTS_SID = "S-1-3-4";
export const TRUSTED_INSTALLER_SID = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";

/** The principals besides the account itself that may hold any right on a private path. */
export const ALLOWED_SIDS: ReadonlySet<string> = new Set([
  SYSTEM_SID,
  ADMINISTRATORS_SID,
  CREATOR_OWNER_SID,
  OWNER_RIGHTS_SID,
  TRUSTED_INSTALLER_SID,
]);

/**
 * Every SDDL alias Windows writes for a SID (Microsoft's "SID strings" table), with its SID where
 * that is fixed and `null` where it depends on the domain (`DU` is `<domain SID>-513`). Unknown to
 * this table, an alias stays as written and is simply not allowed.
 */
const ALIASES: ReadonlyMap<string, { readonly sid: string | null; readonly name: string }> = new Map([
  ["AN", { sid: "S-1-5-7", name: "Anonymous Logon" }],
  ["AO", { sid: "S-1-5-32-548", name: "Account Operators" }],
  ["AU", { sid: "S-1-5-11", name: "Authenticated Users" }],
  ["BA", { sid: ADMINISTRATORS_SID, name: "Administrators" }],
  ["BG", { sid: "S-1-5-32-546", name: "Guests" }],
  ["BO", { sid: "S-1-5-32-551", name: "Backup Operators" }],
  ["BU", { sid: "S-1-5-32-545", name: "Users" }],
  ["CG", { sid: "S-1-3-1", name: "CREATOR GROUP" }],
  ["CO", { sid: CREATOR_OWNER_SID, name: "CREATOR OWNER" }],
  ["ED", { sid: "S-1-5-9", name: "Enterprise Domain Controllers" }],
  ["IU", { sid: "S-1-5-4", name: "Interactive" }],
  ["LS", { sid: "S-1-5-19", name: "Local Service" }],
  ["NO", { sid: "S-1-5-32-556", name: "Network Configuration Operators" }],
  ["NS", { sid: "S-1-5-20", name: "Network Service" }],
  ["NU", { sid: "S-1-5-2", name: "Network" }],
  ["OW", { sid: OWNER_RIGHTS_SID, name: "OWNER RIGHTS" }],
  ["PO", { sid: "S-1-5-32-550", name: "Print Operators" }],
  ["PS", { sid: "S-1-5-10", name: "Principal Self" }],
  ["PU", { sid: "S-1-5-32-547", name: "Power Users" }],
  ["RC", { sid: "S-1-5-12", name: "Restricted Code" }],
  ["RD", { sid: "S-1-5-32-555", name: "Remote Desktop Users" }],
  ["RE", { sid: "S-1-5-32-552", name: "Replicator" }],
  ["RU", { sid: "S-1-5-32-554", name: "Pre-Windows 2000 Compatible Access" }],
  ["SO", { sid: "S-1-5-32-549", name: "Server Operators" }],
  ["SU", { sid: "S-1-5-6", name: "Service" }],
  ["SY", { sid: SYSTEM_SID, name: "SYSTEM" }],
  ["WD", { sid: "S-1-1-0", name: "Everyone" }],
  ["WR", { sid: "S-1-5-33", name: "Write Restricted Code" }],
  ["AC", { sid: "S-1-15-2-1", name: "ALL APPLICATION PACKAGES" }],
  ["RA", { sid: "S-1-5-32-575", name: "RDS Remote Access Servers" }],
  ["MU", { sid: "S-1-5-32-558", name: "Performance Monitor Users" }],
  ["LU", { sid: "S-1-5-32-559", name: "Performance Log Users" }],
  ["IS", { sid: "S-1-5-32-568", name: "IIS_IUSRS" }],
  ["CY", { sid: "S-1-5-32-569", name: "Cryptographic Operators" }],
  ["ER", { sid: "S-1-5-32-573", name: "Event Log Readers" }],
  ["UD", { sid: "S-1-5-84-0-0-0-0-0", name: "User-Mode Drivers" }],
  // Relative to the machine's domain: the SID is not fixed, the name is.
  ["DU", { sid: null, name: "Domain Users" }],
  ["DG", { sid: null, name: "Domain Guests" }],
  ["DA", { sid: null, name: "Domain Admins" }],
  ["DC", { sid: null, name: "Domain Computers" }],
  ["DD", { sid: null, name: "Domain Controllers" }],
  ["LA", { sid: null, name: "the local Administrator account" }],
  ["LG", { sid: null, name: "the local Guest account" }],
  ["CA", { sid: null, name: "Cert Publishers" }],
  ["EA", { sid: null, name: "Enterprise Admins" }],
  ["SA", { sid: null, name: "Schema Admins" }],
  ["PA", { sid: null, name: "Group Policy Creator Owners" }],
  ["RS", { sid: null, name: "RAS and IAS Servers" }],
  ["RO", { sid: null, name: "Enterprise Read-only Domain Controllers" }],
]);

/** Names for fixed SIDs written in full (`icacls /save` spells some of them out). */
const SID_NAMES: ReadonlyMap<string, string> = new Map(
  [...ALIASES.values()].flatMap((a) => (a.sid === null ? [] : [[a.sid, a.name] as const])).concat([
    [TRUSTED_INSTALLER_SID, "TrustedInstaller"],
    ["S-1-15-2-2", "ALL RESTRICTED APPLICATION PACKAGES"],
  ]),
);

/** Names for the well-known ends of a domain or machine SID (`S-1-5-21-<x>-<y>-<z>-<rid>`). */
const RID_NAMES: ReadonlyMap<string, string> = new Map([
  ["500", "the Administrator account"],
  ["501", "the Guest account"],
  ["512", "Domain Admins"],
  ["513", "Domain Users"],
  ["514", "Domain Guests"],
  ["515", "Domain Computers"],
]);

/** The SID an alias stands for, or the text as written when it is a SID or a domain alias. */
export function normaliseSid(text: string): string {
  const upper = text.trim().toUpperCase();
  return ALIASES.get(upper)?.sid ?? upper;
}

/** A name to put in a sentence: `Users`, `Domain Users`, `an app capability`, or `another account`. */
export function sidName(sid: string): string {
  const alias = ALIASES.get(sid);
  if (alias !== undefined) return alias.name;
  const known = SID_NAMES.get(sid);
  if (known !== undefined) return known;
  if (sid.startsWith("S-1-15-3-")) return "an app capability";
  if (sid.startsWith("S-1-12-1-")) return "a Microsoft Entra account";
  const rid = /^S-1-5-21-\d+-\d+-\d+-(\d+)$/.exec(sid)?.[1];
  if (rid !== undefined) return RID_NAMES.get(rid) ?? "another account";
  return "another account";
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/** One access control entry, as much of it as the rule reads. */
export interface Ace {
  /** `A` allow, `D` deny, `OA`/`XA`/`ZA` the other allow kinds, and so on. */
  readonly type: string;
  /** The inheritance flags as written (`OICIID`). */
  readonly flags: string;
  /** The access mask, or `null` when a right in it has no known value. */
  readonly mask: number | null;
  /** The SID; a fixed alias spelled out, a domain alias (`DU`) kept as written. */
  readonly sid: string;
}

/** A discretionary access list. `aces: null` is a null DACL: no list, so anyone may do anything. */
export interface Dacl {
  /** `P`: nothing is inherited from the parent folder. */
  readonly protected: boolean;
  readonly aces: readonly Ace[] | null;
}

/** What one SDDL string says. `owner` is there only when the text had `O:` (Get-Acl, not icacls). */
export interface SecurityDescriptor {
  readonly owner: string | null;
  readonly dacl: Dacl | null;
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

/** The section that starts at `i` (`O:`, `G:`, `D:` or `S:` outside every bracket), or `null`. */
function sectionAt(text: string, i: number): string | null {
  const c = text[i];
  return c !== undefined && "OGDS".includes(c) && text[i + 1] === ":" ? c : null;
}

/**
 * The owner and the DACL of a security descriptor in SDDL (`O:BAG:...D:PAI(A;OICI;FA;;;SY)...`).
 * The group and the audit list are not read. `dacl` is `null` when there is no `D:` part.
 */
export function parseSddl(sddl: string): SecurityDescriptor {
  const text = sddl.trim();
  // Split into sections at the top level. No SID or alias contains a colon, so a letter before a
  // colon outside brackets can only be a section mark, even right after a SID (`...-513D:AI(...)`).
  const sections = new Map<string, string>();
  let depth = 0;
  let current: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0) {
      const mark = sectionAt(text, i);
      if (mark !== null) {
        if (current !== null) sections.set(current, text.slice(start, i));
        current = mark;
        start = i + 2;
        i++;
      }
    }
  }
  if (current !== null) sections.set(current, text.slice(start));
  const ownerText = sections.get("O");
  const owner = ownerText === undefined || ownerText.trim() === "" ? null : normaliseSid(ownerText);
  const daclText = sections.get("D");
  return { owner, dacl: daclText === undefined ? null : parseDacl(daclText) };
}

function parseDacl(text: string): Dacl | null {
  const open = text.indexOf("(");
  const flags = open < 0 ? text : text.slice(0, open);
  if (flags.includes("NO_ACCESS_CONTROL")) return { protected: false, aces: null };
  const aces: Ace[] = [];
  let i = open < 0 ? text.length : open;
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
    aces.push({ type: type.toUpperCase(), flags: aceFlags.toUpperCase(), mask: parseMask(rights), sid: normaliseSid(sid) });
    i = end + 1;
  }
  return { protected: flags.includes("P"), aces };
}

// ── The rule ─────────────────────────────────────────────────────────────────

/** Allow-type entries. `D`, `OD`, `XD` deny; the audit kinds grant nothing. */
const ALLOW_TYPES = new Set(["A", "OA", "XA", "ZA"]);

/** SYNCHRONIZE and READ_ATTRIBUTES: the two rights that say nothing about what is in a file. */
const HARMLESS = 0x100000 | 0x80;

const FULL = 0x1f01ff;
const READ = 0x1 | 0x8 | 0x80000000;
const CHANGE = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x40000000;

/** One principal outside the allowlist that holds a right, and what it can do. */
export interface ForeignGrant {
  readonly sid: string;
  /** `read`, `change`, `full control`, or `access` for something else; `on new files` for inherit-only. */
  readonly what: string;
}

function describe(mask: number | null): string {
  if (mask === null || (mask & 0x10000000) !== 0 || (mask & FULL) === FULL) return "full control";
  if ((mask & CHANGE) !== 0) return "change";
  if ((mask & READ) !== 0) return "read";
  return "access";
}

/**
 * The principals outside the allowlist that `dacl` lets in, one entry per SID (the widest right
 * wins). `user` is the account that runs Collie. Empty means private.
 */
export function foreignGrants(dacl: Dacl, user: string): ForeignGrant[] {
  if (dacl.aces === null) return [{ sid: "S-1-1-0", what: "full control, no access list at all" }];
  const found = new Map<string, ForeignGrant>();
  for (const ace of dacl.aces) {
    if (!ALLOW_TYPES.has(ace.type) || ace.sid === user || ALLOWED_SIDS.has(ace.sid)) continue;
    if (ace.mask !== null && (ace.mask & ~HARMLESS) === 0) continue;
    const inheritOnly = ace.flags.includes("IO");
    // An inherit-only entry that passes to nothing applies to nothing.
    if (inheritOnly && !ace.flags.includes("OI") && !ace.flags.includes("CI")) continue;
    const what = `${describe(ace.mask)}${inheritOnly ? " on new files" : ""}`;
    const before = found.get(ace.sid);
    // The entry that applies to the path itself beats one for new files only.
    if (before === undefined || (before.what.endsWith("on new files") && !inheritOnly)) found.set(ace.sid, { sid: ace.sid, what });
  }
  return [...found.values()];
}

/** The owner when it is someone other than the account, SYSTEM, Administrators or TrustedInstaller. */
export function foreignOwner(sd: SecurityDescriptor, user: string): string | null {
  if (sd.owner === null || sd.owner === user || ALLOWED_SIDS.has(sd.owner)) return null;
  return sd.owner;
}

// ── The two tool outputs ─────────────────────────────────────────────────────

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
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  const out: SavedAcl[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push({ name: lines[i]!, sddl: lines[i + 1]! });
  return out;
}

/** The same format back, for `icacls <parent> /restore <file>`. */
export function formatSaved(entries: readonly SavedAcl[]): string {
  return entries.map((e) => `${e.name}\r\n${e.sddl}\r\n`).join("");
}

/** The SID in `whoami /user /fo csv /nh` (`"pc\pat","S-1-5-21-...-1001"`). The name half may be in any code page. */
export function parseWhoamiSid(stdout: string): string | null {
  const match = /"?(S-1-[0-9]+(?:-[0-9]+)+)"?\s*$/m.exec(stdout.trim());
  return match?.[1] ?? null;
}
