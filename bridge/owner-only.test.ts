import { afterEach, describe, expect, test } from "bun:test";

import { PRIVATE_ROOTS } from "./acl-policy.ts";
import { hostFor } from "./host.ts";
import type { AclTool, RunResult, SaveResult } from "./icacls.ts";
import {
  createPrivateDir,
  dirOutcomeLine,
  ensureOwnerOnlyDir,
  flushAclBackups,
  isOwnerOnly,
  type OwnerOnlyDeps,
  privateCommand,
  quotePath,
  resetOwnerOnlyState,
  secretFileVerdict,
  whoCanRead,
} from "./owner-only.ts";

const WIN = hostFor("win32");
const LINUX = hostFor("linux");
const STATE_ROOT = PRIVATE_ROOTS.find((r) => r.id === "state")!;
const CONFIG_ROOT = PRIVATE_ROOTS.find((r) => r.id === "config")!;

// Real `icacls /save` lines from the Windows 11 VM (2026-10-02); the SID is the VM's `collie`.
const SID = "S-1-5-21-1678274354-1849132225-3673151578-1000";
const HOME = "C:\\Users\\pat";
const STATE = `${HOME}\\.local\\state\\collie`;
const CONFIG = `${HOME}\\AppData\\Roaming\\herdr\\plugins\\config\\herdr.collie`;
const PROFILE_DIR = (name: string) => `${name}\r\nD:(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${SID})\r\n`;
const PROTECTED_DIR = (name: string) => `${name}\r\nD:PAI(A;OICI;FA;;;${SID})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)\r\n`;
const DRIVE_DIR = (name: string) =>
  `${name}\r\nD:AI(A;OICIID;FA;;;BA)(A;OICIID;FA;;;SY)(A;OICIID;0x1200a9;;;BU)(A;ID;0x1301bf;;;AU)(A;OICIIOID;SDGXGWGR;;;AU)\r\n`;
const PRIVATE_FILE = (name: string) => `${name}\r\nD:AI(A;ID;FA;;;BA)(A;ID;FA;;;SY)(A;ID;FA;;;${SID})\r\n`;
const EVERYONE_FILE = (name: string) => `${name}\r\nD:AI(A;;FR;;;WD)(A;ID;FA;;;BA)(A;ID;FA;;;SY)(A;ID;FA;;;${SID})\r\n`;

/** Save answers that are not a text: a timeout, a tool that never started, an exit with no list. */
const TIMED_OUT = "\u0000timed-out";
const NOT_RUN = "\u0000not-run";
const NO_LIST = (code: number) => `\u0000exit ${String(code)}`;

function saveAnswer(answer: string): SaveResult {
  if (answer === TIMED_OUT) return { kind: "timed-out" };
  if (answer === NOT_RUN) return { kind: "not-run" };
  const exitMark = "\u0000exit ";
  return answer.startsWith(exitMark)
    ? { kind: "ok", code: Number(answer.slice(exitMark.length)), text: "" }
    : { kind: "ok", code: 0, text: answer };
}

interface World {
  /** `path` or `path /T` → the save answers in order (the last repeats). */
  saves: Record<string, string[]>;
  files: Record<string, { dir?: boolean; nlink?: number }>;
  links?: Set<string>;
  lists?: Record<string, string[]>;
  env?: Record<string, string>;
  whoami?: string | null;
  repairCode?: number;
}

function fake(world: World) {
  const calls: string[] = [];
  /** Every repair call, as its icacls arguments. */
  const sets: string[][] = [];
  const resets: string[] = [];
  const backups: Record<string, string> = {};
  const seen = new Map<string, number>();
  const links = world.links ?? new Set<string>();
  const acl: AclTool = {
    save(path, tree) {
      const key = tree ? `${path} /T` : path;
      calls.push(`save ${key}`);
      const list = world.saves[key] ?? world.saves[path];
      if (list === undefined) return { kind: "ok", code: 2, text: "" };
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      return saveAnswer(list[Math.min(n, list.length - 1)]!);
    },
    icacls(args) {
      calls.push(`icacls ${args[0]!}`);
      sets.push([...args]);
      return { code: world.repairCode ?? 0, stdout: "", timedOut: false };
    },
    reset(path) {
      calls.push(`reset ${path}`);
      resets.push(path);
      return { code: 0, stdout: "", timedOut: false };
    },
    whoami(): RunResult | null {
      return world.whoami === null ? null : { code: 0, stdout: world.whoami ?? `"pc\\pat","${SID}"\r\n`, timedOut: false };
    },
    descriptors: () => new Map(),
  };
  const deps: OwnerOnlyDeps = {
    acl,
    stat: (path) => {
      const f = world.files[path];
      return f === undefined ? null : { dir: f.dir === true, mode: 0o600, nlink: f.nlink ?? 1 };
    },
    isLink: (path) => links.has(path),
    realpath: (path) => path,
    list: (path) => world.lists?.[path] ?? [],
    mkdir: (path) => void calls.push(`mkdir ${path}`),
    writeBackup: (path, text) => {
      backups[path] = text;
      return true;
    },
    removeFile: (path) => void calls.push(`rm ${path}`),
    env: world.env ?? { USERPROFILE: HOME, APPDATA: `${HOME}\\AppData\\Roaming`, LOCALAPPDATA: `${HOME}\\AppData\\Local`, SystemRoot: "C:\\Windows" },
    home: HOME,
    now: () => Date.UTC(2026, 9, 2, 20, 0, 0),
  };
  return { deps, calls, sets, resets, backups, links };
}

afterEach(() => resetOwnerOnlyState());

// ── The check ────────────────────────────────────────────────────────────────

describe("isOwnerOnly: three answers", () => {
  test("private: a profile folder read once with /T", () => {
    const f = fake({ saves: { [`${STATE} /T`]: [PROFILE_DIR("collie")] }, files: { [STATE]: { dir: true } } });
    expect(isOwnerOnly(STATE, WIN, f.deps)).toEqual({ state: "private" });
    expect(f.calls).toEqual([`save ${STATE} /T`]);
  });

  test("loose: who, what and where, for the folder and a file below it", () => {
    const tree = `${DRIVE_DIR("collie")}collie\\paired-devices.json\r\nD:AI(A;;FR;;;WD)(A;ID;FA;;;SY)\r\n`;
    const f = fake({ saves: { [`${STATE} /T`]: [tree] }, files: { [STATE]: { dir: true } } });
    const v = isOwnerOnly(STATE, WIN, f.deps);
    expect(v.state).toBe("loose");
    if (v.state !== "loose") return;
    expect(v.leaks).toEqual([
      { path: STATE, sid: "S-1-5-32-545", what: "read" },
      { path: STATE, sid: "S-1-5-11", what: "change" },
      { path: `${STATE}\\paired-devices.json`, sid: "S-1-1-0", what: "read" },
    ]);
    expect(whoCanRead(v.leaks)).toBe("Users [S-1-5-32-545], Authenticated Users [S-1-5-11], Everyone [S-1-1-0]");
  });

  test("not-checked, never loose: a timeout, a tool that did not start, no list (FAT, simulated), a share", () => {
    const cases: [string, string][] = [
      [TIMED_OUT, "icacls did not answer within 10 seconds"],
      [NOT_RUN, "icacls did not start"],
      // What a FAT or exFAT volume gives: icacls fails and writes no list. Simulated here only.
      [NO_LIST(1), "icacls found no access list (exit 1); FAT, exFAT and network drives have none"],
    ];
    for (const [answer, reason] of cases) {
      const f = fake({ saves: { [`${STATE} /T`]: [answer] }, files: { [STATE]: { dir: true } } });
      expect(isOwnerOnly(STATE, WIN, f.deps)).toEqual({ state: "not-checked", reason });
    }
    const share = "\\\\nas\\collie";
    expect(isOwnerOnly(share, WIN, fake({ saves: {}, files: { [share]: { dir: true } } }).deps).state).toBe("not-checked");
    const noUser = fake({ saves: { [`${STATE} /T`]: [DRIVE_DIR("collie")] }, files: { [STATE]: { dir: true } }, whoami: null });
    expect(isOwnerOnly(STATE, WIN, noUser.deps).state).toBe("not-checked");
  });

  test("an entry reached through a junction is not Collie's and not counted", () => {
    const tree = `${PROTECTED_DIR("collie")}collie\\link\r\nD:AI(A;ID;FA;;;SY)\r\ncollie\\link\\x.txt\r\nD:AI(A;;FR;;;WD)\r\n`;
    const f = fake({ saves: { [`${STATE} /T`]: [tree] }, files: { [STATE]: { dir: true } }, links: new Set([`${STATE}\\link`]) });
    expect(isOwnerOnly(STATE, WIN, f.deps)).toEqual({ state: "private" });
  });

  test("POSIX keeps the mode rule and runs nothing", () => {
    const f = fake({ saves: {}, files: { "/s/a": {} } });
    expect(isOwnerOnly("/s/a", LINUX, f.deps).state).toBe("private");
    expect(f.calls).toEqual([]);
  });
});

// ── The repair at start ──────────────────────────────────────────────────────

describe("ensureOwnerOnlyDir at bridge start", () => {
  const files = { [STATE]: { dir: true }, [`${STATE}\\crew-trust.json`]: {}, [`${STATE}\\paired-devices.json`]: {} };

  test("POSIX: mkdir with 0700 and nothing else", () => {
    const f = fake({ saves: {}, files: {} });
    expect(ensureOwnerOnlyDir("/home/pat/.local/state/collie", LINUX, { root: STATE_ROOT, repair: true }, f.deps)).toBeNull();
    expect(f.calls).toEqual(["mkdir /home/pat/.local/state/collie"]);
  });

  test("already private: the folder and the secret files that exist, one read each, never /T, no change", () => {
    const f = fake({
      saves: { [STATE]: [PROTECTED_DIR("collie")], [`${STATE}\\crew-trust.json`]: [PRIVATE_FILE("crew-trust.json")], [`${STATE}\\paired-devices.json`]: [PRIVATE_FILE("paired-devices.json")] },
      files,
    });
    expect(ensureOwnerOnlyDir(STATE, WIN, { root: STATE_ROOT, repair: true }, f.deps)).toEqual({ state: "private" });
    expect(f.calls).toEqual([`mkdir ${STATE}`, `save ${STATE}`, `save ${STATE}\\crew-trust.json`, `save ${STATE}\\paired-devices.json`]);
  });

  test("a default location: old list saved first, then one grant-first icacls call, then confirmed", () => {
    const f = fake({
      saves: {
        [STATE]: [DRIVE_DIR("collie"), DRIVE_DIR("collie"), PROTECTED_DIR("collie")],
        [`${STATE}\\crew-trust.json`]: [PRIVATE_FILE("crew-trust.json")],
        [`${STATE}\\paired-devices.json`]: [PRIVATE_FILE("paired-devices.json")],
      },
      files,
    });
    const outcome = ensureOwnerOnlyDir(STATE, WIN, { root: STATE_ROOT, repair: true }, f.deps);
    expect(outcome?.state).toBe("made-private");
    expect(f.sets).toEqual([
      [
        STATE,
        "/grant:r",
        `*${SID}:(OI)(CI)F`,
        "*S-1-5-18:(OI)(CI)F",
        "*S-1-5-32-544:(OI)(CI)F",
        "/inheritance:r",
        "/remove:g",
        "*S-1-5-32-545",
        "*S-1-5-11",
        "/C",
        "/Q",
      ],
    ]);
    // The backup read comes before the change.
    expect(f.calls.indexOf(`save ${STATE}`)).toBeLessThan(f.calls.indexOf(`icacls ${STATE}`));
    expect(dirOutcomeLine(STATE, outcome, f.deps)).toBe(
      `[secrets] ${STATE} could be read by other accounts on this PC (Users [S-1-5-32-545], Authenticated Users [S-1-5-11]). ` +
        "Collie restricted it to your account, SYSTEM and Administrators. Nothing for you to do. If this repeats on every start, " +
        "something resets the permissions (a backup restore, a sync tool, antivirus).",
    );
    const lines = flushAclBackups(STATE, WIN, f.deps);
    const file = `${STATE}\\acl-backups\\acl-backup-2026-10-02T20-00-00-000Z-1.sddl`;
    expect(lines).toEqual([
      `[secrets] the old permissions are saved. To put them back, in a terminal run as administrator: icacls "${HOME}\\.local\\state" /restore "${file}"`,
    ]);
    expect(f.backups[file]).toBe(DRIVE_DIR("collie"));
  });

  test("a custom folder that also holds other things is checked only: one warning with the fix, no change", () => {
    const dir = "D:\\Projects";
    const f = fake({
      saves: { [dir]: [DRIVE_DIR("Projects")] },
      files: { [dir]: { dir: true }, [`${dir}\\src`]: { dir: true }, [`${dir}\\package.json`]: {}, [`${dir}\\crew-trust.json`]: {} },
      lists: { [dir]: ["src", "package.json", "crew-trust.json"] },
    });
    const outcome = ensureOwnerOnlyDir(dir, WIN, { root: STATE_ROOT, repair: true }, f.deps);
    expect(outcome).toEqual({
      state: "left-loose",
      leaks: [
        { path: dir, sid: "S-1-5-32-545", what: "read" },
        { path: dir, sid: "S-1-5-11", what: "change" },
      ],
      why: "it also holds files that are not Collie's (src, package.json)",
    });
    expect(f.sets).toEqual([]);
    expect(f.resets).toEqual([]);
    expect(dirOutcomeLine(dir, outcome, f.deps)).toBe(
      `[secrets] ${dir} can be read by other accounts on this PC (Users [S-1-5-32-545], Authenticated Users [S-1-5-11]). ` +
        "Collie did not change it, because it also holds files that are not Collie's (src, package.json). To make it private, run: " +
        `icacls "${dir}" /grant:r "*${SID}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" /inheritance:r /remove:g *S-1-5-32-545 *S-1-5-11`,
    );
  });

  test("the off switch: checked and reported, never changed", () => {
    const f = fake({ saves: { [STATE]: [DRIVE_DIR("collie")] }, files: { [STATE]: { dir: true } } });
    const outcome = ensureOwnerOnlyDir(STATE, WIN, { root: STATE_ROOT, repair: false }, f.deps);
    expect(outcome?.state).toBe("left-loose");
    if (outcome?.state === "left-loose") expect(outcome.why).toBe("COLLIE_NO_ACL_REPAIR=1 is set");
    expect(f.sets).toEqual([]);
  });

  test("a secret file with its own grant: reset after a fresh lstat, then confirmed", () => {
    const trust = `${STATE}\\crew-trust.json`;
    const f = fake({
      saves: { [STATE]: [PROTECTED_DIR("collie")], [trust]: [EVERYONE_FILE("crew-trust.json"), EVERYONE_FILE("crew-trust.json"), EVERYONE_FILE("crew-trust.json"), PRIVATE_FILE("crew-trust.json")] },
      files: { [STATE]: { dir: true }, [trust]: {} },
    });
    expect(ensureOwnerOnlyDir(STATE, WIN, { root: STATE_ROOT, repair: true }, f.deps)?.state).toBe("made-private");
    expect(f.resets).toEqual([trust]);
  });

  test("a junction swapped in between the check and the change: nothing outside is touched", () => {
    const trust = `${STATE}\\crew-trust.json`;
    const world: World = {
      saves: { [STATE]: [PROTECTED_DIR("collie")], [trust]: [EVERYONE_FILE("crew-trust.json")] },
      files: { [STATE]: { dir: true }, [trust]: {} },
    };
    const f = fake(world);
    // The read finds a plain file. Once the folder's list is set, the name becomes a link to
    // elsewhere: the fresh lstat right before the reset must see it and skip the reset.
    let swapped = false;
    const deps: OwnerOnlyDeps = {
      ...f.deps,
      isLink: (p) => swapped && p === trust,
      acl: {
        ...f.deps.acl,
        icacls: (args) => {
          swapped = true;
          return f.deps.acl.icacls(args);
        },
      },
    };
    const outcome = ensureOwnerOnlyDir(STATE, WIN, { root: STATE_ROOT, repair: true }, deps);
    expect(f.resets).toEqual([]);
    expect(outcome?.state).toBe("repair-failed");
  });

  test("a hard link (nlink 2) is never reset: a second name would carry the change elsewhere", () => {
    const trust = `${STATE}\\crew-trust.json`;
    const f = fake({
      saves: { [STATE]: [PROTECTED_DIR("collie")], [trust]: [EVERYONE_FILE("crew-trust.json")] },
      files: { [STATE]: { dir: true }, [trust]: { nlink: 2 } },
    });
    const outcome = ensureOwnerOnlyDir(STATE, WIN, { root: STATE_ROOT, repair: true }, f.deps);
    expect(f.resets).toEqual([]);
    expect(outcome?.state).toBe("repair-failed");
    expect(dirOutcomeLine(STATE, outcome, f.deps)).toContain("then restart Collie.");
  });

  test("a drive root, a share or the profile itself is never changed, even with the switch on", () => {
    for (const dir of ["C:\\", "\\\\nas\\s\\collie", HOME]) {
      const f = fake({ saves: { [dir]: [DRIVE_DIR("x")] }, files: { [dir]: { dir: true } } });
      const outcome = ensureOwnerOnlyDir(dir, WIN, { root: STATE_ROOT, repair: true }, f.deps);
      expect(f.sets).toEqual([]);
      expect(["left-loose", "not-checked"]).toContain(outcome!.state);
    }
  });

  test("created now (by this bridge): repaired with no backup, wherever it is", () => {
    const dir = "D:\\collie-state";
    const f = fake({
      // No backup read: nothing existed before this run. A check, the change, a confirming read.
      saves: { [dir]: [DRIVE_DIR("collie-state"), PROTECTED_DIR("collie-state")] },
      files: { [dir]: { dir: true } },
      lists: { [dir]: ["unrelated.txt"] },
    });
    expect(ensureOwnerOnlyDir(dir, WIN, { root: STATE_ROOT, repair: true, createdNow: true }, f.deps)?.state).toBe("made-private");
    expect(flushAclBackups(dir, WIN, f.deps)).toEqual([]);
  });

  test("backups keep the last three runs", () => {
    const f = fake({ saves: { [STATE]: [DRIVE_DIR("collie")] }, files: { [STATE]: { dir: true } }, lists: {
      [`${STATE}\\acl-backups`]: ["acl-backup-2026-01-1.sddl", "acl-backup-2026-02-1.sddl", "acl-backup-2026-03-1.sddl", "acl-backup-2026-03-2.sddl", "acl-backup-2026-10-02T20-00-00-000Z-1.sddl"],
    } });
    ensureOwnerOnlyDir(STATE, WIN, { root: STATE_ROOT, repair: true }, f.deps);
    flushAclBackups(STATE, WIN, f.deps);
    expect(f.calls.filter((c) => c.startsWith("rm "))).toEqual([`rm ${STATE}\\acl-backups\\acl-backup-2026-01-1.sddl`]);
  });
});

// ── One secret file, for the loader ──────────────────────────────────────────

describe("secretFileVerdict", () => {
  const ENV = `${CONFIG}\\.env`;

  test("a CLI command (repair off) on a loose .env warns with the fix and changes NOTHING", () => {
    const f = fake({ saves: { [ENV]: [EVERYONE_FILE(".env")] }, files: { [ENV]: {} } });
    const v = secretFileVerdict(ENV, { repair: false }, f.deps);
    expect(v).toEqual({
      ok: false,
      warning:
        `warn: ${ENV} can be read by other accounts on this PC (Everyone [S-1-1-0]). Restart Collie to repair it, or run: ` +
        `icacls "${ENV}" /grant:r "*${SID}:F" "*S-1-5-18:F" "*S-1-5-32-544:F" /inheritance:r /remove:g *S-1-1-0`,
    });
    expect(f.sets).toEqual([]);
    expect(f.resets).toEqual([]);
  });

  test("the bridge (repair on) in a default folder: saved, set in one call, confirmed", () => {
    const f = fake({ saves: { [ENV]: [EVERYONE_FILE(".env"), EVERYONE_FILE(".env"), PRIVATE_FILE(".env")] }, files: { [ENV]: {}, [CONFIG]: { dir: true } } });
    const v = secretFileVerdict(ENV, { repair: true }, f.deps);
    expect(v.ok).toBe(true);
    expect(v.warning).toBe(
      `warn: ${ENV} could be read by other accounts on this PC (Everyone [S-1-1-0]). Collie restricted it to your account, SYSTEM and Administrators.`,
    );
    expect(f.sets).toEqual([
      [ENV, "/grant:r", `*${SID}:F`, "*S-1-5-18:F", "*S-1-5-32-544:F", "/inheritance:r", "/remove:g", "*S-1-1-0", "/C", "/Q"],
    ]);
  });

  test("a hard link (nlink 2) or a link is never changed: a warning with the fix, the secret withheld", () => {
    for (const world of [{ files: { [ENV]: { nlink: 2 }, [CONFIG]: { dir: true } } }, { files: { [ENV]: {}, [CONFIG]: { dir: true } }, links: new Set([ENV]) }]) {
      const f = fake({ saves: { [ENV]: [EVERYONE_FILE(".env")] }, ...world });
      const v = secretFileVerdict(ENV, { repair: true }, f.deps);
      expect(v.ok).toBe(false);
      expect(v.warning).toBe(
        `warn: ${ENV} can be read by other accounts on this PC (Everyone [S-1-1-0]). Collie did not change it, because it is a link or has ` +
          `a second name (a hard link), so the change would reach a file elsewhere. Fix it yourself, or run: ` +
          `icacls "${ENV}" /grant:r "*${SID}:F" "*S-1-5-18:F" "*S-1-5-32-544:F" /inheritance:r /remove:g *S-1-1-0`,
      );
      expect(f.sets).toEqual([]);
      expect(f.resets).toEqual([]);
      expect(f.calls.filter((c) => c.startsWith("save ")).length).toBe(1);
    }
  });

  test("the bridge with COLLIE_NO_ACL_REPAIR=1: a warning, no change", () => {
    const f = fake({ saves: { [ENV]: [EVERYONE_FILE(".env")] }, files: { [ENV]: {} }, env: { [`COLLIE_NO_ACL_REPAIR`]: "1", USERPROFILE: HOME } });
    expect(secretFileVerdict(ENV, { repair: true }, f.deps).ok).toBe(false);
    expect(f.sets).toEqual([]);
  });

  test("a secret in a folder that is not Collie's: checked, not changed, and withheld", () => {
    const toml = "D:\\shared\\config.toml";
    const f = fake({ saves: { [toml]: [EVERYONE_FILE("config.toml")] }, files: { [toml]: {} }, lists: { "D:\\shared": ["config.toml", "notes.txt"] } });
    const v = secretFileVerdict(toml, { repair: true }, f.deps);
    expect(v.ok).toBe(false);
    expect(v.warning).toContain("Collie did not change it, because it also holds files that are not Collie's (notes.txt). Fix it yourself, or run: icacls");
    expect(f.sets).toEqual([]);
  });

  test("not checked: no claim, the secret is used, and it is said once per process", () => {
    const f = fake({ saves: { [ENV]: [TIMED_OUT] }, files: { [ENV]: {} } });
    expect(secretFileVerdict(ENV, { repair: false }, f.deps)).toEqual({
      ok: true,
      warning: `note: cannot confirm who can read ${ENV}: icacls did not answer within 10 seconds.`,
    });
    expect(secretFileVerdict(ENV, { repair: false }, f.deps)).toEqual({ ok: true, warning: null });
  });
});

describe("the rest", () => {
  test("createPrivateDir: a folder born now gets the private list; off with the switch; nothing off Windows", () => {
    const f = fake({ saves: {}, files: {} });
    createPrivateDir(STATE, WIN, f.deps);
    expect(f.sets.map((r) => r[0])).toEqual([STATE]);
    const off = fake({ saves: {}, files: {}, env: { COLLIE_NO_ACL_REPAIR: "1" } });
    createPrivateDir(STATE, WIN, off.deps);
    expect(off.sets).toEqual([]);
    const posix = fake({ saves: {}, files: {} });
    createPrivateDir("/s", LINUX, posix.deps);
    expect(posix.calls).toEqual(["mkdir /s"]);
  });

  test("privateCommand: quoted path, grants first, then /inheritance:r, SIDs only, no placeholder", () => {
    expect(privateCommand("C:\\Users\\Rehearse Ünal\\x", SID, true, [{ path: "x", sid: "S-1-5-4", what: "read" }, { path: "x", sid: "DU", what: "read" }])).toBe(
      `icacls "C:\\Users\\Rehearse Ünal\\x" /grant:r "*${SID}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" /inheritance:r /remove:g *S-1-5-4`,
    );
  });

  test("a path with `$` or a backtick is single-quoted, `'` doubled, so PowerShell pastes it as written", () => {
    expect(quotePath("C:\\Users\\pat\\collie")).toBe('"C:\\Users\\pat\\collie"');
    expect(quotePath("C:\\Users\\o'brien\\collie")).toBe('"C:\\Users\\o\'brien\\collie"');
    expect(quotePath("D:\\$work\\pat's `cfg")).toBe("'D:\\$work\\pat''s `cfg'");
    expect(privateCommand("D:\\$env:x\\it's", SID, false)).toBe(
      `icacls 'D:\\$env:x\\it''s' /grant:r "*${SID}:F" "*S-1-5-18:F" "*S-1-5-32-544:F" /inheritance:r`,
    );
  });

  test("the config root names .env and config.toml as its secrets", () => {
    expect(CONFIG_ROOT.secrets).toEqual([".env", "config.toml"]);
  });
});
