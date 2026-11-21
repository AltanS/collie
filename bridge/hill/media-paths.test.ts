// The Hill's image reader under other spellings of Collie's own folders (Windows, 2026-11-22). On Windows
// one folder has several names: its 8.3 short name, a `subst` drive, a junction, a lower-case drive letter.
// The reader resolved a posted path with `realpathSync`, which keeps an 8.3 name and a `subst` drive, so a
// file in the state folder named that way was read while its long name was refused. A file inside Collie's
// own folders must be refused by every spelling, in either direction: the folder configured one way and
// the file posted another. Each spelling is built by hand; a host that cannot make one skips that case
// and says why. The trick's own folder (inside the config folder) keeps passing by its real path.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deniedFoldersSync, MEDIA_DIR, readPostedImage } from "./media.ts";

const WINDOWS = process.platform === "win32";

const made: string[] = [];
const substs: string[] = [];
afterAll(() => {
  for (const drive of substs) spawnSync("subst", [drive, "/d"]);
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
const chunk = (type: string, data: number[]) => [...be32(data.length), ...ascii(type), ...data, 0, 0, 0, 0];

/** A 128 x 128 PNG the Hill's reader takes (the CRCs are zero: nothing checks them). */
function png(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk("IHDR", [...be32(128), ...be32(128), 8, 6, 0, 0, 0]), ...chunk("IDAT", Array.from({ length: 16 }, () => 0)), ...chunk("IEND", [])]);
}

/** A folder by the OS's own real path, named longer than eight characters so it gets an 8.3 name. */
function base(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "collie-hill-spellings-")));
  made.push(root);
  for (const dir of ["state", join("config", "tricks", "legs"), "outside"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "state", "x.png"), png());
  writeFileSync(join(root, "config", "tricks", "legs", "shot.png"), png());
  writeFileSync(join(root, "outside", "x.png"), png());
  return root;
}

/** The 8.3 short name of a folder, or `null` when the volume made none. */
function shortName(path: string): string | null {
  // Verbatim, so the quotes reach cmd as written (quoted for a C runtime, cmd reads them as part of the path).
  const out = spawnSync("cmd", ["/d", "/s", "/c", `"for %I in ("${path}") do @echo %~sI"`], { encoding: "utf8", windowsVerbatimArguments: true });
  const short = out.status === 0 ? out.stdout.trim() : "";
  return short !== "" && short.toLowerCase() !== path.toLowerCase() ? short : null;
}

/** A free drive letter `subst` to `path`, or `null` when none is free or `subst` refuses. */
function substDrive(path: string): string | null {
  for (const letter of "ZYXWVUTSRQPONM") {
    const drive = `${letter}:`;
    if (existsSync(`${drive}\\`)) continue;
    if (spawnSync("subst", [drive, path]).status !== 0) return null;
    substs.push(drive);
    return `${drive}\\`;
  }
  return null;
}

/** A junction to `path`, or `null` when this host cannot make one. */
function junctionTo(path: string): string | null {
  const at = realpathSync.native(mkdtempSync(join(tmpdir(), "collie-hill-link-")));
  made.push(at);
  try {
    symlinkSync(path, join(at, "link"), "junction");
    return join(at, "link");
  } catch {
    return null;
  }
}

const root = base();
const drive = root.slice(0, 1);
const SPELLINGS: [string, string | null, string][] = [
  ["an 8.3 short name", WINDOWS ? shortName(root) : null, WINDOWS ? "the volume makes no 8.3 names" : "only Windows has 8.3 names"],
  ["a subst drive", WINDOWS ? substDrive(root) : null, WINDOWS ? "no drive letter is free, or subst refused" : "only Windows has subst"],
  ["a junction", WINDOWS ? junctionTo(root) : null, "only Windows has junctions"],
  ["a lower-case drive letter", WINDOWS && drive !== drive.toLowerCase() ? drive.toLowerCase() + root.slice(1) : null, "only Windows has drive letters"],
];

describe("the Hill's reader refuses Collie's own folders by every spelling", () => {
  for (const [name, spelled, why] of SPELLINGS) {
    // A spelling this host cannot make is reported as a skip with its reason, never as a pass.
    const run = spelled === null ? test.skip : test;
    const suffix = spelled === null ? ` (skipped: ${why})` : "";

    run(`a file in the state folder posted by ${name} is refused${suffix}`, () => {
      const at = spelled ?? "";
      const denied = deniedFoldersSync([join(root, "state"), join(root, "config")]);
      expect(readPostedImage(join(at, "state", "x.png"), denied)).toMatchObject({ ok: false, code: "bad_image" });
      // The list refuses the folder, not every post: the file outside it, by its real path, is read.
      expect(readPostedImage(join(root, "outside", "x.png"), denied)).toMatchObject({ ok: true });
    });

    run(`a state folder configured by ${name} refuses the file posted by its real path${suffix}`, () => {
      const at = spelled ?? "";
      const denied = deniedFoldersSync([join(at, "state"), join(at, "config")]);
      expect(readPostedImage(join(root, "state", "x.png"), denied)).toMatchObject({ ok: false, code: "bad_image" });
      expect(readPostedImage(join(root, "outside", "x.png"), denied)).toMatchObject({ ok: true });
    });

    run(`a trick's own image passes by its real path with the config folder configured by ${name}${suffix}`, () => {
      const at = spelled ?? "";
      const denied = deniedFoldersSync([join(at, "state"), join(at, "config")]);
      const never = deniedFoldersSync([join(at, "state"), join(at, "state", "hill", MEDIA_DIR)]);
      const legs = join(root, "config", "tricks", "legs");
      expect(readPostedImage(join(legs, "shot.png"), denied, { root: legs, never })).toMatchObject({ ok: true });
      // Without its root, the same file is Collie's own.
      expect(readPostedImage(join(legs, "shot.png"), denied)).toMatchObject({ ok: false, code: "bad_image" });
    });
  }
});
