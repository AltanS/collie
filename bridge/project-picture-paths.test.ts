// The project picture under other spellings of the same folder (Windows CI, 2026-11-21). On Windows one
// folder has several names: its 8.3 short name (`C:\Users\RUNNER~1`, the runner's temp folder), a `subst`
// drive, a junction, a lower-case drive letter, and a symlinked folder (on every host). The project file's
// walk and reads resolve every one of them to the OS's own real path, so a session reached by any of them
// gets its picture. The bridge's own folders must be denied by every one of them too: a state folder
// configured by its short name or a `subst` drive once let the picture inside it pass, because the denied
// list kept that spelling while the picture's path had the long one (bridge/hill/media.ts,
// `deniedFoldersSync`). Each spelling is built by hand; a host that cannot make one skips that case and
// says why.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { locateProjectFile } from "./project-file.ts";
import { ProjectPictures, pictureVersion, projectPictureDenied } from "./project-picture.ts";

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

/** A 128 x 128 PNG that passes every picture rule (the CRCs are zero: nothing checks them). */
function png(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk("IHDR", [...be32(128), ...be32(128), 8, 6, 0, 0, 0]), ...chunk("IDAT", Array.from({ length: 16 }, () => 0)), ...chunk("IEND", [])]);
}

/**
 * A repository with a picture in its own tree and one in its state folder, by the OS's own real path.
 * The folder's name is longer than eight characters, so a volume that makes 8.3 names gives it one.
 */
function repository(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "collie-picture-spellings-")));
  made.push(root);
  mkdirSync(join(root, ".git", "objects"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(root, "state"));
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "logo.png"), png());
  writeFileSync(join(root, "state", "logo.png"), png());
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

/** A link to `path` of one kind, beside it, or `null` when this host may not make one. */
function linkTo(path: string, kind: "junction" | "dir"): string | null {
  const at = realpathSync.native(mkdtempSync(join(tmpdir(), "collie-picture-link-")));
  made.push(at);
  try {
    symlinkSync(path, join(at, "link"), kind);
    return join(at, "link");
  } catch {
    return null; // a symlinked folder on Windows needs an administrator or developer mode
  }
}

/** Each spelling of `root` this host can make, by name; `null` with the reason it cannot. */
function spellings(root: string): [string, string | null, string][] {
  const drive = root.slice(0, 1);
  return [
    ["a symlinked folder", linkTo(root, "dir"), "this host may not make a symlinked folder"],
    ["an 8.3 short name", WINDOWS ? shortName(root) : null, WINDOWS ? "the volume makes no 8.3 names" : "only Windows has 8.3 names"],
    ["a subst drive", WINDOWS ? substDrive(root) : null, WINDOWS ? "no drive letter is free, or subst refused" : "only Windows has subst"],
    ["a junction", WINDOWS ? linkTo(root, "junction") : null, "only Windows has junctions"],
    ["a lower-case drive letter", WINDOWS && drive !== drive.toLowerCase() ? drive.toLowerCase() + root.slice(1) : null, "only Windows has drive letters"],
  ];
}

const root = repository();

describe("one folder, every spelling", () => {
  for (const [name, spelled, why] of spellings(root)) {
    // A spelling this host cannot make is reported as a skip with its reason, never as a pass.
    const run = spelled === null ? test.skip : test;
    const suffix = spelled === null ? ` (skipped: ${why})` : "";

    run(`a state folder named by ${name} still denies the picture inside it${suffix}`, async () => {
      const at = spelled ?? "";
      const denied = projectPictureDenied({ stateDir: join(at, "state"), configDir: join(at, "config") });
      writeFileSync(join(root, "collie.toml"), '[project]\nicon = "state/logo.png"\n');
      const refused = await new ProjectPictures(true, denied).report(root);
      expect(refused.icon).toMatchObject({ ok: false, why: expect.stringContaining("Collie's own folders") });
      const pictures = new ProjectPictures(true, denied);
      await pictures.refresh([root]);
      expect(pictures.get(root)).toBeUndefined();
      // The same list lets a picture outside those folders pass, so the refusal is the folder's doing.
      writeFileSync(join(root, "collie.toml"), '[project]\nicon = "logo.png"\n');
      expect((await new ProjectPictures(true, denied).report(root)).icon).toMatchObject({ ok: true });
    });

    run(`a session in the folder reached by ${name} gets the picture, by the folder's real path${suffix}`, async () => {
      const at = spelled ?? "";
      writeFileSync(join(root, "collie.toml"), '[project]\nicon = "logo.png"\n');
      expect(await locateProjectFile(at)).toEqual({ file: join(root, "collie.toml"), root });
      const pictures = new ProjectPictures(true, projectPictureDenied({ stateDir: join(root, "state"), configDir: join(root, "config") }));
      await pictures.refresh([at]);
      expect(pictures.get(at)).toBe(pictureVersion(png()));
    });
  }
});
