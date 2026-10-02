import { describe, expect, test } from "bun:test";

import {
  defaultLocations,
  isCollieName,
  isNetworkPath,
  neverTouch,
  PRIVATE_ROOTS,
  repairScope,
  systemPlaces,
} from "./acl-policy.ts";
import { hostFor } from "./host.ts";

const WIN = hostFor("win32");
const ENV = {
  SystemRoot: "C:\\Windows",
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  ProgramData: "C:\\ProgramData",
  USERPROFILE: "C:\\Users\\Rehearse Ünal",
  APPDATA: "C:\\Users\\Rehearse Ünal\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\Rehearse Ünal\\AppData\\Local",
};
const HOME = ENV.USERPROFILE;

// The real-path step, as `realpathSync.native` answered on the VM (2026-10-02): `C:\PROGRA~1` and
// `\\?\C:\Program Files` and `c:\program files` all came back `C:\Program Files`.
const REAL = new Map([
  ["C:\\PROGRA~1", "C:\\Program Files"],
  ["\\\\?\\C:\\Program Files", "C:\\Program Files"],
  ["c:\\program files", "C:\\Program Files"],
]);
const realpath = (p: string): string => {
  for (const [from, to] of REAL) if (p.toLowerCase().startsWith(from.toLowerCase())) return to + p.slice(from.length);
  return p;
};
const places = systemPlaces(ENV, realpath);
const defaults = defaultLocations(WIN, ENV, HOME);
const scope = (path: string, names: string[] | null = [], createdNow = false) =>
  repairScope({ realPath: realpath(path), createdNow, names }, WIN, places, defaults);

describe("never touch", () => {
  test("the places come from the environment, not from a hard-coded C:", () => {
    expect(systemPlaces({ SystemRoot: "E:\\WINNT", USERPROFILE: "E:\\Users\\pat" }, realpath).map((p) => p.path)).toEqual([
      "E:\\WINNT",
      "E:\\Users\\pat",
    ]);
  });

  test("a drive root, a network share, the profile itself and anything holding a system place", () => {
    for (const path of ["C:\\", "D:\\", "C:\\Users", "C:\\Users\\Rehearse Ünal", "\\\\nas\\share\\collie", "\\\\?\\UNC\\nas\\s"]) {
      expect(neverTouch(path, WIN, places)).not.toBeNull();
    }
  });

  test("inside Windows or Program Files, under any spelling, once the real path is known", () => {
    for (const path of ["C:\\PROGRA~1\\Collie", "\\\\?\\C:\\Program Files\\Collie", "c:\\program files\\collie", "C:\\WINDOWS\\Temp\\x"]) {
      expect(neverTouch(realpath(path), WIN, places)).toContain("inside");
    }
  });

  test("inside the profile or ProgramData is not off limits by itself", () => {
    expect(neverTouch("C:\\Users\\Rehearse Ünal\\.local\\state\\collie", WIN, places)).toBeNull();
    expect(neverTouch("C:\\ProgramData\\collie", WIN, places)).toBeNull();
    expect(isNetworkPath("\\\\?\\C:\\x")).toBe(false);
  });
});

describe("the repair scope", () => {
  test("(b) the default locations under the profile, whatever they hold", () => {
    for (const path of [
      "C:\\Users\\Rehearse Ünal\\.local\\state\\collie",
      "C:\\Users\\Rehearse Ünal\\.local\\state\\collie-next",
      "C:\\Users\\Rehearse Ünal\\AppData\\Roaming\\herdr\\plugins\\config\\herdr.collie",
      "C:\\Users\\Rehearse Ünal\\AppData\\Local\\herdr\\plugins\\herdr.collie-next",
      "c:\\users\\rehearse ünal\\.config\\collie",
      "C:\\Users\\Rehearse Ünal\\.collie",
    ]) {
      expect(scope(path, ["Documents", "photo.jpg"])).toEqual({ allowed: true });
    }
  });

  test("(a) created in this run, even somewhere custom", () => {
    expect(scope("D:\\Projects\\collie-state", ["photo.jpg"], true)).toEqual({ allowed: true });
  });

  test("(c) an existing custom folder that is empty or holds only Collie's names", () => {
    expect(scope("D:\\data\\collie", [])).toEqual({ allowed: true });
    expect(scope("D:\\data\\collie", ["crew-trust.json", "audit.log.1", "uploads", "acl-backup-2026-1.sddl", ".env"])).toEqual({
      allowed: true,
    });
  });

  test("any other existing folder is checked only, and the reason names what is not Collie's", () => {
    const s = scope("D:\\Projects", ["crew-trust.json", "src", "README.md", "package.json", "x"]);
    expect(s).toEqual({ allowed: false, why: "it is not only Collie's: it also holds src, README.md, package.json and more" });
    expect(scope("D:\\Projects", null).allowed).toBe(false);
  });

  test("never-touch wins over every rule, even 'created now' or a default name", () => {
    expect(scope("C:\\Users\\Rehearse Ünal", [], true).allowed).toBe(false);
    expect(scope("\\\\nas\\share\\collie", [], true).allowed).toBe(false);
    expect(scope("C:\\PROGRA~1\\collie", [], true)).toEqual({
      allowed: false,
      why: "Collie never changes it: it is inside C:\\Program Files",
    });
  });
});

describe("names", () => {
  test("every secret file a root names is a Collie name", () => {
    for (const root of PRIVATE_ROOTS) for (const name of root.secrets) expect(isCollieName(name)).toBe(true);
  });

  test("shapes and suffixes count; a stranger does not", () => {
    for (const name of ["collie.log", "collie-next.pid", "collie-next-processes", "herdr.collie.task.xml", "tailscale-managed-handler-next", "update-staging-ab12", "crew-trust.json.tmp"]) {
      expect(isCollieName(name)).toBe(true);
    }
    for (const name of ["notes.txt", "src", ".git", "envelope"]) expect(isCollieName(name)).toBe(false);
  });
});
