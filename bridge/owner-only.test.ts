import { afterEach, describe, expect, test } from "bun:test";

import { hostFor } from "./host.ts";
import {
  type AclTool,
  broadReaders,
  dirOutcomeLine,
  ensureOwnerOnlyDir,
  forgetUnknownNotes,
  isOwnerOnly,
  type OwnerOnlyDeps,
  ownerOnlyArgs,
  ownerOnlyCommand,
  parseSaved,
  parseSddl,
  parseWhoamiSid,
  secretFileVerdict,
} from "./owner-only.ts";

const WIN = hostFor("win32");
const LINUX = hostFor("linux");

// ── Real output, captured on the Windows 11 test VM on 2026-10-02 ────────────
// `icacls <path> /save <file>` writes UTF-16: the name, then the SDDL. The user is the VM's
// `collie` account; the SIDs below are its real ones.

const SID = "S-1-5-21-1678274354-1849132225-3673151578-1000";

/** `%APPDATA%\herdr\plugins\config\herdr.collie` on a fresh profile: inherited from the profile, no Users. */
const PROFILE_DIR = `herdr.collie\r\nD:(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${SID})\r\n`;

/** A folder made under `C:\`: it inherits read for Users and modify for Authenticated Users. */
const DRIVE_ROOT_DIR =
  "scratch\r\nD:AI(A;OICIID;FA;;;BA)(A;OICIID;FA;;;SY)(A;OICIID;0x1200a9;;;BU)(A;ID;0x1301bf;;;AU)(A;OICIIOID;SDGXGWGR;;;AU)\r\n";

/** `.env` after `icacls .env /grant Everyone:R`, in that same folder. */
const ENV_EVERYONE = ".env\r\nD:AI(A;;FR;;;WD)(A;ID;FA;;;BA)(A;ID;FA;;;SY)(A;ID;0x1200a9;;;BU)(A;ID;0x1301bf;;;AU)\r\n";

/** `.env` in a private folder with an explicit Everyone grant, the case doctor must name. */
const ENV_EVERYONE_PRIVATE_DIR = `.env\r\nD:AI(A;;FR;;;WD)(A;ID;FA;;;BA)(A;ID;FA;;;SY)(A;ID;FA;;;${SID})\r\n`;

/** After `icacls deny.txt /deny Everyone:R`: a deny entry, which is no leak, beside the inherited Users read. */
const DENY_EVERYONE = "deny.txt\r\nD:AI(D;;FR;;;WD)(A;ID;FA;;;BA)(A;ID;FA;;;SY)(A;ID;0x1200a9;;;BU)(A;ID;0x1301bf;;;AU)\r\n";

/** A folder after the repair, read with `/T`: protected, three principals, the children inherit. */
const PROTECTED_TREE = [
  "Jürgen Öz A",
  `D:PAI(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;FA;;;${SID})`,
  "Jürgen Öz A\\.env",
  `D:AI(A;ID;FA;;;BA)(A;ID;FA;;;SY)(A;ID;FA;;;${SID})`,
  "Jürgen Öz A\\sub",
  `D:AI(A;OICIID;FA;;;BA)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;${SID})`,
  "Jürgen Öz A\\sub\\b.txt",
  `D:AI(A;ID;FA;;;BA)(A;ID;FA;;;SY)(A;ID;FA;;;${SID})`,
  "",
].join("\r\n");

/** `whoami /user /fo csv /nh`. The name half is in the console code page; only the SID is read. */
const WHOAMI = `"win-75jufu04dbi\\collie","${SID}"\r\n`;

/**
 * What the plain `icacls` output says on a German Windows (the shape of it, not a capture): the
 * names are translated, so a parser of this text would miss `Jeder` for Everyone. The module reads
 * SDDL from `/save` instead, and this text is no SDDL.
 */
const GERMAN_PLAIN = [
  "C:\\daten\\.env Jeder:(R)",
  "               VORDEFINIERT\\Benutzer:(I)(RX)",
  "               NT-AUTORITÄT\\SYSTEM:(I)(F)",
  "",
  "1 Dateien erfolgreich verarbeitet, bei 0 Dateien ist ein Verarbeitungsfehler aufgetreten.",
].join("\r\n");

// ── A fake of the three tools ────────────────────────────────────────────────

/** A read that exits with `code`, having written `text` (nothing, by default). */
class Exit {
  constructor(
    readonly code: number,
    readonly text = "",
  ) {}
}

interface Fake {
  deps: OwnerOnlyDeps;
  /** Every `icacls` repair, as its argument vector. */
  repairs: string[][];
  /** Every read, as `<path> /T` or `<path>`. */
  reads: string[];
  made: string[];
}

/**
 * `saves[path]` answers the reads of that path in order (the last one repeats). A string is the
 * saved text with exit 0; an {@link Exit} sets the exit too; `null` is "icacls did not start".
 */
function fake(
  saves: Record<string, (string | Exit | null)[]>,
  over: { dirs?: string[]; whoami?: string | null; repairCode?: number; mode?: number; links?: string[] } = {},
): Fake {
  const repairs: string[][] = [];
  const reads: string[] = [];
  const made: string[] = [];
  const seen = new Map<string, number>();
  const acl: AclTool = {
    save(path, tree) {
      reads.push(tree ? `${path} /T` : path);
      const list = saves[path];
      if (list === undefined) return { code: 2, text: "" };
      const n = seen.get(path) ?? 0;
      seen.set(path, n + 1);
      const answer = list[Math.min(n, list.length - 1)];
      if (answer === null || answer === undefined) return null;
      return answer instanceof Exit ? { code: answer.code, text: answer.text } : { code: 0, text: answer };
    },
    icacls(args) {
      repairs.push([...args]);
      return { code: over.repairCode ?? 0, stdout: "Successfully processed 1 files; Failed processing 0 files\r\n" };
    },
    whoami() {
      return over.whoami === null ? null : { code: 0, stdout: over.whoami ?? WHOAMI };
    },
  };
  const dirs = new Set(over.dirs ?? []);
  return {
    repairs,
    reads,
    made,
    deps: {
      acl,
      stat: (path) => (path in saves || dirs.has(path) ? { dir: dirs.has(path), mode: over.mode ?? 0o600 } : null),
      mkdir: (path) => void made.push(path),
      systemPlaces: ["C:\\Windows", "C:\\Program Files", "C:\\ProgramData", "C:\\Users\\pat"],
      isLink: (path) => (over.links ?? []).includes(path),
    },
  };
}

afterEach(() => forgetUnknownNotes());

// ── SDDL ─────────────────────────────────────────────────────────────────────

describe("parseSddl and broadReaders", () => {
  test("a profile folder is owner-only: SYSTEM, Administrators and the user, all inherited", () => {
    const dacl = parseSddl(parseSaved(PROFILE_DIR)[0]!.sddl)!;
    expect(dacl.protected).toBe(false);
    expect(dacl.aces!.map((a) => a.sid)).toEqual(["S-1-5-18", "S-1-5-32-544", SID]);
    expect(broadReaders(dacl)).toEqual([]);
  });

  test("a folder under C:\\ is not: Users read it and Authenticated Users change it, inherit-only included", () => {
    expect(broadReaders(parseSddl(parseSaved(DRIVE_ROOT_DIR)[0]!.sddl)!)).toEqual([
      "Users (S-1-5-32-545)",
      "Authenticated Users (S-1-5-11)",
    ]);
  });

  test("an explicit Everyone read is named first, by its SID", () => {
    expect(broadReaders(parseSddl(parseSaved(ENV_EVERYONE_PRIVATE_DIR)[0]!.sddl)!)).toEqual(["Everyone (S-1-1-0)"]);
  });

  test("a deny entry is no leak; the inherited Users read beside it still is", () => {
    expect(broadReaders(parseSddl(parseSaved(DENY_EVERYONE)[0]!.sddl)!)).toEqual([
      "Users (S-1-5-32-545)",
      "Authenticated Users (S-1-5-11)",
    ]);
  });

  test("the protected flag is read from PAI, and the owner and group before D: are skipped", () => {
    const full = `O:BAG:S-1-5-21-1678274354-1849132225-3673151578-513D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${SID})`;
    const dacl = parseSddl(full)!;
    expect(dacl.protected).toBe(true);
    expect(dacl.aces).toHaveLength(3);
  });

  test("execute or attribute rights alone are no read; Guests and a SID spelled out are found", () => {
    expect(broadReaders(parseSddl("D:(A;;0x1200a0;;;BU)(A;;FX;;;WD)")!)).toEqual([]);
    expect(broadReaders(parseSddl("D:(A;;0x1;;;S-1-5-32-546)(A;;GR;;;S-1-1-0)")!)).toEqual([
      "Guests (S-1-5-32-546)",
      "Everyone (S-1-1-0)",
    ]);
  });

  test("a right the parser does not know counts as read, so an odd list fails closed", () => {
    expect(broadReaders(parseSddl("D:(A;;ZZ;;;BU)")!)).toEqual(["Users (S-1-5-32-545)"]);
  });

  test("a null DACL lets everyone in", () => {
    const dacl = parseSddl("D:NO_ACCESS_CONTROL")!;
    expect(dacl.aces).toBeNull();
    expect(broadReaders(dacl)[0]).toContain("Everyone (S-1-1-0)");
  });

  test("a conditional entry keeps its own brackets and does not end the list early", () => {
    const dacl = parseSddl('D:(XA;;FR;;;WD;(@User.Project Any_of {"x"}))(A;;FA;;;SY)')!;
    expect(dacl.aces!.map((a) => a.sid)).toEqual(["S-1-1-0", "S-1-5-18"]);
    expect(broadReaders(dacl)).toEqual(["Everyone (S-1-1-0)"]);
  });

  test("the plain, translated icacls output is not SDDL, which is why the module asks for /save", () => {
    expect(parseSddl(GERMAN_PLAIN)).toBeNull();
  });
});

describe("parseSaved and parseWhoamiSid", () => {
  test("a /T save is a name line then an SDDL line for each entry, non-ASCII names whole", () => {
    expect(parseSaved(PROTECTED_TREE).map((e) => e.name)).toEqual([
      "Jürgen Öz A",
      "Jürgen Öz A\\.env",
      "Jürgen Öz A\\sub",
      "Jürgen Öz A\\sub\\b.txt",
    ]);
  });

  test("the SID comes out of whoami whatever the name half says", () => {
    expect(parseWhoamiSid(WHOAMI)).toBe(SID);
    // The name in the console code page, garbled for a user named `Rehearse Ünal`.
    expect(parseWhoamiSid('"win-75jufu04dbi\\rehearse \x9anal","S-1-5-21-1-2-3-1002"')).toBe("S-1-5-21-1-2-3-1002");
    expect(parseWhoamiSid("ERROR: Access is denied.")).toBeNull();
  });
});

// ── The check ────────────────────────────────────────────────────────────────

describe("isOwnerOnly on Windows", () => {
  const DIR = "C:\\Users\\pat\\AppData\\Roaming\\herdr\\plugins\\config\\herdr.collie";
  const ENV = `${DIR}\\.env`;

  test("a folder is read once, with everything below it", () => {
    const f = fake({ [DIR]: [PROFILE_DIR] }, { dirs: [DIR] });
    expect(isOwnerOnly(DIR, WIN, f.deps)).toEqual({ state: "private" });
    expect(f.reads).toEqual([`${DIR} /T`]);
  });

  test("a file is read with its own folder, and the Everyone grant on it is named", () => {
    const f = fake({ [ENV]: [ENV_EVERYONE_PRIVATE_DIR], [DIR]: [PROFILE_DIR] }, { dirs: [DIR] });
    expect(isOwnerOnly(ENV, WIN, f.deps)).toEqual({
      state: "loose",
      principals: ["Everyone (S-1-1-0)"],
      where: [ENV],
    });
    expect(f.reads).toEqual([ENV, DIR]);
  });

  test("a private file in a folder Users can read is not owner-only", () => {
    const f = fake({ [ENV]: [`.env\r\nD:(A;;FA;;;${SID})\r\n`], [DIR]: [DRIVE_ROOT_DIR] }, { dirs: [DIR] });
    const verdict = isOwnerOnly(ENV, WIN, f.deps);
    expect(verdict.state).toBe("loose");
    if (verdict.state === "loose") expect(verdict.where).toEqual([DIR]);
  });

  test("a loose file deep in a folder fails the folder", () => {
    const tree = `${PROTECTED_TREE}uploads\\a.png\r\nD:AI(A;;FR;;;WD)(A;ID;FA;;;SY)\r\n`;
    const f = fake({ [DIR]: [tree] }, { dirs: [DIR] });
    const verdict = isOwnerOnly(DIR, WIN, f.deps);
    expect(verdict).toEqual({ state: "loose", principals: ["Everyone (S-1-1-0)"], where: ["uploads\\a.png"] });
  });

  test("a path whose list cannot be read is unknown, never loose", () => {
    // `icacls` exits 5 and writes nothing for a file this user may not read (VM, a file owned by SYSTEM).
    const f = fake({ [DIR]: [new Exit(5)] }, { dirs: [DIR] });
    expect(isOwnerOnly(DIR, WIN, f.deps)).toEqual({ state: "unknown", why: "icacls exited 5 and wrote no access list" });
    const missing = fake({});
    expect(isOwnerOnly("C:\\nope", WIN, missing.deps)).toEqual({ state: "unknown", why: "it cannot be read" });
    const absentTool = fake({ [DIR]: [null] }, { dirs: [DIR] });
    expect(isOwnerOnly(DIR, WIN, absentTool.deps).state).toBe("unknown");
  });
});

describe("isOwnerOnly on POSIX reads the mode bits, as before", () => {
  test("0600 and 0400 files and 0700 folders pass; anything with group or other bits fails", () => {
    expect(isOwnerOnly("/s/a", LINUX, fake({ "/s/a": [""] }, { mode: 0o600 }).deps).state).toBe("private");
    expect(isOwnerOnly("/s/a", LINUX, fake({ "/s/a": [""] }, { mode: 0o400 }).deps).state).toBe("private");
    expect(isOwnerOnly("/s/a", LINUX, fake({ "/s/a": [""] }, { mode: 0o644 }).deps).state).toBe("loose");
    expect(isOwnerOnly("/s", LINUX, fake({}, { dirs: ["/s"], mode: 0o700 }).deps).state).toBe("private");
    expect(isOwnerOnly("/s", LINUX, fake({}, { dirs: ["/s"], mode: 0o750 }).deps).state).toBe("loose");
  });

  test("and never runs icacls", () => {
    const f = fake({ "/s/a": [""] });
    isOwnerOnly("/s/a", LINUX, f.deps);
    expect(f.reads).toEqual([]);
  });
});

// ── The repair ───────────────────────────────────────────────────────────────

describe("ownerOnlyArgs and ownerOnlyCommand", () => {
  test("a folder: protected, three principals by SID with inheritance, every broad grant removed", () => {
    expect(ownerOnlyArgs("C:\\s", SID, true)).toEqual([
      "C:\\s",
      "/inheritance:r",
      "/grant:r",
      `*${SID}:(OI)(CI)F`,
      "*S-1-5-18:(OI)(CI)F",
      "*S-1-5-32-544:(OI)(CI)F",
      "/remove:g",
      "*S-1-1-0",
      "*S-1-5-32-545",
      "*S-1-5-11",
      "*S-1-5-32-546",
      "/Q",
    ]);
  });

  test("a file gets the same without the inheritance flags", () => {
    expect(ownerOnlyArgs("C:\\s\\.env", SID, false).slice(3, 6)).toEqual([`*${SID}:F`, "*S-1-5-18:F", "*S-1-5-32-544:F"]);
  });

  test("the line for an operator quotes the path and the grants PowerShell would read as an expression", () => {
    expect(ownerOnlyCommand("C:\\Users\\Rehearse Ünal\\.local\\state\\collie", SID, true)).toBe(
      `icacls "C:\\Users\\Rehearse Ünal\\.local\\state\\collie" /inheritance:r /grant:r "*${SID}:(OI)(CI)F" ` +
        `"*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" /remove:g *S-1-1-0 *S-1-5-32-545 *S-1-5-11 *S-1-5-32-546`,
    );
  });
});

describe("ensureOwnerOnlyDir", () => {
  const STATE = "C:\\Users\\pat\\.local\\state\\collie";
  const PROTECTED_STATE = `collie\r\nD:PAI(A;OICI;FA;;;${SID})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)\r\n`;
  const PROFILE_STATE = `collie\r\nD:(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${SID})\r\n`;

  test("POSIX: mkdir with 0700 and nothing else, and nothing to say", () => {
    const f = fake({});
    expect(ensureOwnerOnlyDir("/home/pat/.local/state/collie", LINUX, f.deps)).toBeNull();
    expect(f.made).toEqual(["/home/pat/.local/state/collie"]);
    expect(f.reads).toEqual([]);
    expect(f.repairs).toEqual([]);
  });

  test("Windows, already protected and private: one read is the whole cost", () => {
    const f = fake({ [STATE]: [PROTECTED_STATE] });
    expect(ensureOwnerOnlyDir(STATE, WIN, f.deps)).toEqual({ state: "private" });
    expect(f.reads).toEqual([`${STATE} /T`]);
    expect(f.repairs).toEqual([]);
  });

  test("Windows, private by inheritance only: protected once, confirmed by a second read", () => {
    const f = fake({ [STATE]: [PROFILE_STATE, PROTECTED_STATE] });
    const outcome = ensureOwnerOnlyDir(STATE, WIN, f.deps);
    expect(outcome).toEqual({ state: "made-private", was: [] });
    expect(f.repairs).toEqual([ownerOnlyArgs(STATE, SID, true)]);
    expect(dirOutcomeLine(STATE, outcome)).toBe(
      `[secrets] made ${STATE} owner-only: only you, SYSTEM and Administrators can open it.`,
    );
  });

  test("Windows, a child with its own grant: only that entry is reset, never the whole tree", () => {
    // The folder's own list is fine, so setting it changes nothing for a child with an explicit grant:
    // the second read still shows it, and that one entry alone is reset to inherit.
    const before = `${PROTECTED_STATE}collie\\crew-trust.json\r\nD:AI(A;;FR;;;WD)(A;ID;FA;;;SY)\r\n`;
    const f = fake({ [STATE]: [before, before, PROTECTED_STATE] });
    const outcome = ensureOwnerOnlyDir(STATE, WIN, f.deps);
    expect(outcome).toEqual({ state: "made-private", was: ["Everyone (S-1-1-0)"] });
    expect(f.repairs).toEqual([
      ownerOnlyArgs(STATE, SID, true),
      ["C:\\Users\\pat\\.local\\state\\collie\\crew-trust.json", "/reset", "/C", "/Q"],
    ]);
    expect(f.reads).toEqual([`${STATE} /T`, `${STATE} /T`, `${STATE} /T`]);
    expect(dirOutcomeLine(STATE, outcome)).toBe(`[secrets] ${STATE} was readable by Everyone (S-1-1-0); made it owner-only.`);
  });

  test("Windows, a loose file behind a junction is not Collie's: not blamed, and never reset", () => {
    // `icacls /T` follows a junction (VM, 2026-10-02): `collie\link\shared.txt` is a file in a folder
    // outside the state dir. Resetting it would change a file somewhere else on the disk.
    const tree = `${PROTECTED_STATE}collie\\link\r\nD:AI(A;ID;FA;;;SY)\r\ncollie\\link\\shared.txt\r\nD:AI(A;;FR;;;WD)(A;ID;FA;;;SY)\r\n`;
    const f = fake({ [STATE]: [tree] }, { dirs: [STATE], links: [`${STATE}\\link`] });
    expect(ensureOwnerOnlyDir(STATE, WIN, f.deps)).toEqual({ state: "private" });
    expect(f.repairs).toEqual([]);
    expect(isOwnerOnly(STATE, WIN, f.deps)).toEqual({ state: "private" });
    // The same file with no link on the way is Collie's, and is named.
    const plain = fake({ [STATE]: [tree] }, { dirs: [STATE] });
    expect(isOwnerOnly(STATE, WIN, plain.deps).state).toBe("loose");
  });

  test("Windows, children that only inherited the leak are fixed by the folder's list alone", () => {
    const before = `${DRIVE_ROOT_DIR}scratch\\push.json\r\nD:AI(A;ID;FA;;;SY)(A;ID;0x1200a9;;;BU)\r\n`;
    const f = fake({ [STATE]: [before, PROTECTED_STATE] });
    expect(ensureOwnerOnlyDir(STATE, WIN, f.deps)?.state).toBe("made-private");
    expect(f.repairs).toEqual([ownerOnlyArgs(STATE, SID, true)]);
  });

  test("Windows, a drive root or a folder holding the profile or Windows is read and never changed", () => {
    for (const place of ["C:\\", "C:\\Users", "C:\\Users\\pat", "c:\\windows"]) {
      const f = fake({ [place]: [DRIVE_ROOT_DIR] });
      const outcome = ensureOwnerOnlyDir(place, WIN, f.deps);
      expect(outcome?.state).toBe("loose");
      if (outcome?.state === "loose") expect(outcome.why).toContain("Collie never changes");
      expect(f.repairs).toEqual([]);
    }
    // Private already, it stays as it is, unprotected or not: nothing to say and nothing to change.
    const quiet = fake({ "C:\\Users\\pat": [PROFILE_STATE] });
    expect(ensureOwnerOnlyDir("C:\\Users\\pat", WIN, quiet.deps)).toEqual({ state: "private" });
    expect(quiet.repairs).toEqual([]);
  });

  test("Windows, the repair did not take: never 'made owner-only', and the line carries the fix", () => {
    const f = fake({ [STATE]: [DRIVE_ROOT_DIR, DRIVE_ROOT_DIR] });
    const outcome = ensureOwnerOnlyDir(STATE, WIN, f.deps);
    expect(outcome?.state).toBe("loose");
    const line = dirOutcomeLine(STATE, outcome, SID)!;
    expect(line).not.toContain("made it owner-only");
    expect(line).toContain("could not be made owner-only");
    expect(line).toContain(ownerOnlyCommand(STATE, SID, true));
  });

  test("Windows, icacls refused the change: loose, with its exit code", () => {
    const f = fake({ [STATE]: [DRIVE_ROOT_DIR] }, { repairCode: 5 });
    expect(ensureOwnerOnlyDir(STATE, WIN, f.deps)).toEqual({
      state: "loose",
      principals: ["Users (S-1-5-32-545)", "Authenticated Users (S-1-5-11)"],
      why: "icacls exited 5",
    });
  });

  test("Windows, unreadable: unknown, nothing repaired, and the line claims nothing about the folder", () => {
    const f = fake({ [STATE]: [new Exit(5)] });
    const outcome = ensureOwnerOnlyDir(STATE, WIN, f.deps);
    expect(outcome?.state).toBe("unknown");
    expect(f.repairs).toEqual([]);
    expect(dirOutcomeLine(STATE, outcome)).toBe(
      `[secrets] could not read the access list of ${STATE} (icacls exited 5 and wrote no access list); Collie cannot say who can read it.`,
    );
  });
});

describe("secretFileVerdict: the config loader's Windows rule", () => {
  const ENV = "C:\\Users\\pat\\AppData\\Roaming\\herdr\\plugins\\config\\herdr.collie\\.env";
  const FIXED = `.env\r\nD:PAI(A;;FA;;;${SID})(A;;FA;;;SY)(A;;FA;;;BA)\r\n`;

  test("private: nothing to say, and no repair", () => {
    const f = fake({ [ENV]: [`.env\r\nD:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;${SID})\r\n`] });
    expect(secretFileVerdict(ENV, f.deps)).toEqual({ ok: true, warning: null });
    expect(f.repairs).toEqual([]);
  });

  test("loose, repaired, and confirmed by a second read: 'made it owner-only'", () => {
    const f = fake({ [ENV]: [ENV_EVERYONE, FIXED] });
    expect(secretFileVerdict(ENV, f.deps)).toEqual({
      ok: true,
      warning: `warn: ${ENV} was readable by Everyone (S-1-1-0), Users (S-1-5-32-545), Authenticated Users (S-1-5-11); made it owner-only.`,
    });
    expect(f.repairs).toEqual([ownerOnlyArgs(ENV, SID, false)]);
  });

  test("loose and the second read still loose: ok is false, so the loader withholds the secrets", () => {
    const f = fake({ [ENV]: [ENV_EVERYONE, ENV_EVERYONE] });
    const verdict = secretFileVerdict(ENV, f.deps);
    expect(verdict.ok).toBe(false);
    expect(verdict.warning).toContain("could not be made owner-only");
    expect(verdict.warning).not.toContain("made it owner-only.");
  });

  test("loose and no SID to grant to: no repair is tried, and it says so plainly", () => {
    const f = fake({ [ENV]: [ENV_EVERYONE] }, { whoami: null });
    const verdict = secretFileVerdict(ENV, f.deps);
    expect(verdict.ok).toBe(false);
    expect(f.repairs).toEqual([]);
    expect(verdict.warning).toContain("<your SID from whoami /user>");
  });

  test("unreadable: no claim about the file, and said once per process", () => {
    const f = fake({ [ENV]: [new Exit(5)] });
    const first = secretFileVerdict(ENV, f.deps);
    expect(first.ok).toBe(true);
    expect(first.warning).toBe(
      `note: could not read the access list of ${ENV} (icacls exited 5 and wrote no access list); Collie cannot say who can read it.`,
    );
    expect(secretFileVerdict(ENV, f.deps)).toEqual({ ok: true, warning: null });
  });
});
