import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { fallbackDirs, findIn, findTool, searchDirs, toolExts } from "./tools.ts";

// The whole reason this module exists: Herdr spawns plugin actions with no login shell, so PATH may
// be minimal or absent (the pre-shim collie-ctl.sh). PATH is a hint here, never the mechanism.

const HOME = "/home/tester";

describe("searchDirs", () => {
  test("PATH entries come first, then the absolute fallbacks", () => {
    const dirs = searchDirs("/opt/x/bin:/opt/y/bin", HOME);
    expect(dirs.slice(0, 2)).toEqual(["/opt/x/bin", "/opt/y/bin"]);
    expect(dirs).toContain("/usr/bin");
  });

  test("with no PATH at all the fallbacks are the whole list", () => {
    expect(searchDirs(undefined, HOME)).toEqual(fallbackDirs(HOME));
    expect(searchDirs("", HOME)).toEqual(fallbackDirs(HOME));
  });

  test("relative and empty PATH entries are dropped", () => {
    // An empty entry means "the current directory" — resolving `git` through it would let whatever
    // directory we happen to be in supply the binary.
    const dirs = searchDirs(":.:relative/bin:/opt/ok", HOME);
    expect(dirs.filter((d) => !d.startsWith("/"))).toEqual([]);
    expect(dirs).toContain("/opt/ok");
  });

  test("every fallback dir is absolute and home-derived ones use the resolved home", () => {
    for (const d of fallbackDirs(HOME)) expect(d.startsWith("/")).toBe(true);
    expect(fallbackDirs(HOME)).toContain(`${HOME}/.bun/bin`);
    expect(fallbackDirs(HOME)).toContain(`${HOME}/.local/bin`);
  });

  test("a dir named twice is searched once", () => {
    const dirs = searchDirs("/usr/bin:/usr/bin", HOME);
    expect(dirs.filter((d) => d === "/usr/bin")).toHaveLength(1);
  });
});

describe("findTool", () => {
  // An absolute name is CHECKED WHERE IT IS, never searched for: `join(dir, "/usr/bin/tmux")` asks
  // after `/usr/bin/usr/bin/tmux` in every directory and answers "not installed" about a binary that
  // is right there. `collie doctor` runs the mux adapters' own resolved binary through this.
  test("an absolute name that exists resolves to itself, with no PATH at all", () => {
    expect(findTool(process.execPath, {}, HOME)).toBe(process.execPath);
  });

  test("an absolute name that does not exist is null, and no directory is searched for it", () => {
    expect(findTool("/nowhere/at/all/tmux", { PATH: "/usr/bin" }, HOME)).toBeNull();
  });
});

describe("findIn", () => {
  test("returns the first hit as an absolute path", () => {
    expect(findIn("git", ["/a", "/b"], (p) => p === "/b/git")).toBe("/b/git");
  });

  test("earlier dirs win", () => {
    expect(findIn("git", ["/a", "/b"], () => true)).toBe("/a/git");
  });

  test("nothing found is null, not a throw — the caller reports `X not found`", () => {
    expect(findIn("git", ["/a", "/b"], () => false)).toBeNull();
  });

  test("no dirs is null", () => {
    expect(findIn("git", [], () => true)).toBeNull();
  });

  // On Windows the executable is `git.exe`, and a lookup for the bare name finds nothing — which
  // reads downstream as "git is not installed" rather than "we looked for the wrong filename".
  test("every suffix is tried within a directory before moving to the next one", () => {
    expect(findIn("git", ["/a", "/b"], (p) => p === "/b/git.exe", ["", ".exe"])).toBe("/b/git.exe");
  });

  test("the bare name wins over a suffixed sibling in the same directory", () => {
    expect(findIn("git", ["/a"], () => true, ["", ".exe"])).toBe("/a/git");
  });

  test("PATH order still decides — an earlier dir's suffixed hit beats a later dir's bare one", () => {
    expect(findIn("git", ["/a", "/b"], (p) => p === "/a/git.exe" || p === "/b/git", ["", ".exe"])).toBe(
      "/a/git.exe",
    );
  });
});

describe("toolExts", () => {
  // Off Windows there is no such thing as an executable suffix, so the search must not grow one:
  // a lone `""` keeps `findIn` doing exactly what it did before suffixes existed.
  // The platform is passed, never read: these ran on a Windows host only, which is a host we do
  // not have, so the branch they cover went untested on every machine that runs this suite.
  test("is the bare name alone off win32", () => {
    expect(toolExts({ PATHEXT: ".COM;.EXE" }, "linux")).toEqual([""]);
  });

  test("is the bare name first, then PATHEXT, on win32", () => {
    expect(toolExts({ PATHEXT: ".COM;.EXE" }, "win32")).toEqual(["", ".COM", ".EXE"]);
  });

  test("falls back to the standard suffixes with no PATHEXT", () => {
    expect(toolExts({}, "win32")).toEqual(["", ".COM", ".EXE", ".BAT", ".CMD"]);
  });

  // Windows spells it `PathExt`, and case survives only while the environment is the live
  // `process.env` proxy — this module is handed plain copies of it.
  test("reads the name case-insensitively on win32", () => {
    expect(toolExts({ PathExt: ".COM;.EXE" }, "win32")).toEqual(["", ".COM", ".EXE"]);
  });
});

describe("findTool on win32, from a host that is not Windows", () => {
  // A `.cmd` shim is how `herdr`, `bun` and `python3` usually arrive on Windows. The suffix search
  // has to reach it, or the Updates page preflight reports every tool as missing.
  //
  // The suffix is spelled lowercase in both the file name and `PATHEXT` because this test runs on a
  // case-sensitive filesystem. Windows itself matches `.CMD` against `herdr.cmd`; the mechanism
  // under test is the suffix loop, not the case rule of the filesystem it runs on.
  const dir = mkdtempSync(join(tmpdir(), "collie-tools-"));
  const shim = join(dir, "herdr.cmd");
  writeFileSync(shim, "@echo off\n");
  chmodSync(shim, 0o755);
  const env = { PATH: dir, PATHEXT: ".cmd" };

  test("a `.cmd` shim on PATH resolves", () => {
    expect(findTool("herdr", env, HOME, "win32")).toBe(shim);
  });

  test("the same shim is not matched on linux — there the bare name is the only candidate", () => {
    expect(findTool("herdr", env, HOME, "linux")).toBeNull();
  });
});
