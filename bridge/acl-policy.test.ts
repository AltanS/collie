import { describe, expect, test } from "bun:test";

import {
  defaultLocations,
  type EntryKind,
  isCollieEntry,
  isCollieName,
  isNetworkPath,
  isStateSecretName,
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
/** Every entry a plain file, unless `kinds` says otherwise (by the relative path, joined with `\\`). */
const scope = (path: string, names: string[] | null = [], createdNow = false, kinds: Record<string, EntryKind> = {}) =>
  repairScope({ realPath: realpath(path), createdNow, names, look: (rel) => kinds[rel.join("\\")] ?? { kind: "file" } }, WIN, places, defaults);

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
    const uploads: EntryKind = { kind: "folder", names: [] };
    expect(scope("D:\\data\\collie", ["crew-trust.json", "audit.log.1", "uploads", "acl-backup-2026-1.sddl", ".env"], false, { uploads })).toEqual({
      allowed: true,
    });
  });

  test("any other existing folder is checked only, and the reason names what is not Collie's", () => {
    const s = scope("D:\\Projects", ["crew-trust.json", "src", "README.md", "package.json", "x"]);
    expect(s).toEqual({ allowed: false, why: "it also holds files that are not Collie's (src, README.md, package.json and more)" });
    expect(scope("D:\\Projects", null).allowed).toBe(false);
  });

  test("never-touch wins over every rule, even 'created now' or a default name", () => {
    expect(scope("C:\\Users\\Rehearse Ünal", [], true).allowed).toBe(false);
    expect(scope("\\\\nas\\share\\collie", [], true).allowed).toBe(false);
    expect(scope("C:\\PROGRA~1\\collie", [], true)).toEqual({
      allowed: false,
      why: "it is inside C:\\Program Files, and Collie never changes such a folder",
    });
  });
});

describe("names", () => {
  test("a state secret name, in any case and with Collie's own suffix, is a state secret; config names are not", () => {
    for (const name of PRIVATE_ROOTS.find((r) => r.id === "state")!.secrets) {
      expect(isStateSecretName(name)).toBe(true);
      expect(isStateSecretName(name.toUpperCase())).toBe(true);
      expect(isStateSecretName(`${name}.tmp`)).toBe(true);
    }
    expect(isStateSecretName("pack-trust.json")).toBe(true);
    expect(isStateSecretName("paired-devices.json.4242.7.tmp")).toBe(true);
    for (const name of ["activity.json", "crew-trust.json.bak", "my-stt.json", ".env", "config.toml"]) {
      expect(isStateSecretName(name)).toBe(false);
    }
  });

  test("every secret file a root names is a Collie name", () => {
    for (const root of PRIVATE_ROOTS) for (const name of root.secrets) expect(isCollieName(name)).toBe(true);
  });

  test("shapes and suffixes count; a stranger does not", () => {
    for (const name of ["collie.log", "collie-next.pid", "collie-next-processes", "collie-restart", "herdr.collie.task.xml", "tailscale-managed-handler-next", "update-staging-ab12", "crew-trust.json.tmp"]) {
      expect(isCollieName(name)).toBe(true);
    }
    for (const name of ["notes.txt", "src", ".git", "envelope"]) expect(isCollieName(name)).toBe(false);
  });

  test("only Collie's own suffixes follow a Collie name: a rotation and its temporary files", () => {
    for (const name of ["audit.log.1", "crew-trust.json.tmp", "collie-processes.4242.tmp", "paired-devices.json.4242.7.tmp", ".env.collie-tmp", ".env.push-keys.tmp"]) {
      expect(isCollieName(name)).toBe(true);
    }
    for (const name of [".env.production", ".env.local", "audit.log.x", "config.toml.bak", "stt.json.old", "paired-devices.json.1.2.3.tmp"]) {
      expect(isCollieName(name)).toBe(false);
    }
  });

  test("a folder is Collie's only by its name AND its contents, one level deep; a link never is", () => {
    const at = (kinds: Record<string, EntryKind>) => (rel: readonly string[]) => kinds[rel.join("/")] ?? null;
    const folder = (names: string[]): EntryKind => ({ kind: "folder", names });
    const file: EntryKind = { kind: "file" };
    // Empty, or holding only its own kind of file.
    expect(isCollieEntry("fonts", at({ fonts: folder([]) }))).toBe(true);
    expect(isCollieEntry("fonts", at({ fonts: folder(["departure.woff2"]), "fonts/departure.woff2": file }))).toBe(true);
    expect(isCollieEntry("uploads", at({ uploads: folder(["p1_2-mf3x9q-0a1b2c3d.png"]), "uploads/p1_2-mf3x9q-0a1b2c3d.png": file }))).toBe(true);
    expect(isCollieEntry("beacons", at({ beacons: folder(["w1.json"]), "beacons/w1.json": file }))).toBe(true);
    expect(isCollieEntry("acl-backups", at({ "acl-backups": folder(["acl-backup-2026-1.sddl"]), "acl-backups/acl-backup-2026-1.sddl": file }))).toBe(true);
    // The operator's own things under one of those names.
    expect(isCollieEntry("fonts", at({ fonts: folder(["Arial.ttf"]), "fonts/Arial.ttf": file }))).toBe(false);
    expect(isCollieEntry("uploads", at({ uploads: folder(["holiday.jpg"]), "uploads/holiday.jpg": file }))).toBe(false);
    // A subfolder, even one with a Collie-looking name, is one level too deep.
    expect(isCollieEntry("fonts", at({ fonts: folder(["x.woff2"]), "fonts/x.woff2": folder([]) }))).toBe(false);
    // A folder that cannot be listed, a folder with a file's name, a file with a folder's name.
    expect(isCollieEntry("uploads", at({ uploads: { kind: "folder", names: null } }))).toBe(false);
    expect(isCollieEntry("audit.log", at({ "audit.log": folder([]) }))).toBe(false);
    expect(isCollieEntry("uploads", at({ uploads: file }))).toBe(false);
    // A junction named like Collie's folder, and a link named like Collie's file.
    expect(isCollieEntry("uploads", at({ uploads: { kind: "link" } }))).toBe(false);
    expect(isCollieEntry(".env", at({ ".env": { kind: "link" } }))).toBe(false);
    // Unreadable.
    expect(isCollieEntry("stt.json", at({}))).toBe(false);
  });

  test("rule (c) names the stranger: a `.env.production`, a `fonts` of photos, a junction", () => {
    const shared = "D:\\work\\collie-cfg";
    expect(scope(shared, [".env", ".env.production"])).toEqual({ allowed: false, why: "it also holds files that are not Collie's (.env.production)" });
    expect(scope(shared, [".env", "fonts"], false, { fonts: { kind: "folder", names: ["me.jpg"] } })).toEqual({
      allowed: false,
      why: "it also holds files that are not Collie's (fonts)",
    });
    expect(scope(shared, [".env", "uploads"], false, { uploads: { kind: "link" } }).allowed).toBe(false);
    expect(scope(shared, [".env", "audit.log.1", "fonts"], false, { fonts: { kind: "folder", names: [] } })).toEqual({ allowed: true });
  });
});
