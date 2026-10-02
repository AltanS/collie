import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

import { describe, expect, test } from "bun:test";

import { hostFor } from "../bridge/host.ts";
import { fallbackDirs, findIn, findTool, searchDirs, toolExts } from "./tools.ts";

// The whole reason this module exists: Herdr spawns plugin actions with no login shell, so PATH may
// be minimal or absent (the pre-shim collie-ctl.sh). PATH is a hint here, never the mechanism.

const HOME = "/home/tester";

describe("searchDirs", () => {
  test("PATH entries come first, then the absolute fallbacks", () => {
    const dirs = searchDirs(["/opt/x/bin", "/opt/y/bin"].join(delimiter), HOME);
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
    const dirs = searchDirs(["", ".", "relative/bin", "/opt/ok"].join(delimiter), HOME);
    expect(dirs.filter((d) => !isAbsolute(d))).toEqual([]);
    expect(dirs).toContain("/opt/ok");
  });

  test("every fallback dir is absolute and home-derived ones use the resolved home", () => {
    for (const d of fallbackDirs(HOME)) expect(isAbsolute(d)).toBe(true);
    expect(fallbackDirs(HOME)).toContain(join(HOME, ".bun", "bin"));
    expect(fallbackDirs(HOME)).toContain(join(HOME, ".local", "bin"));
  });

  test("a dir named twice is searched once", () => {
    const dirs = searchDirs(["/usr/bin", "/usr/bin"].join(delimiter), HOME);
    expect(dirs.filter((d) => d === "/usr/bin")).toHaveLength(1);
  });
});

describe("searchDirs reads the PATH of the host it is given", () => {
  test("a Windows PATH splits at semicolons and keeps drive and UNC entries, whatever the machine", () => {
    const path = "C:\\Program Files\\Tools;D:\\tools;\\\\srv\\share\\bin;relative\\bin";
    const dirs = searchDirs(path, HOME, hostFor("win32"));
    expect(dirs.slice(0, 3)).toEqual(["C:\\Program Files\\Tools", "D:\\tools", "\\\\srv\\share\\bin"]);
    expect(dirs).not.toContain("relative\\bin");
  });

  test("a POSIX host splits at colons and drops a drive-lettered entry", () => {
    const dirs = searchDirs("/opt/a:/opt/b:C", HOME, hostFor("linux"));
    expect(dirs.slice(0, 2)).toEqual(["/opt/a", "/opt/b"]);
    expect(dirs).not.toContain("C");
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
    const hit = join("/b", "git");
    expect(findIn("git", ["/a", "/b"], (p) => p === hit)).toBe(hit);
  });

  test("earlier dirs win", () => {
    expect(findIn("git", ["/a", "/b"], () => true)).toBe(join("/a", "git"));
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
    const hit = join("/b", "git.exe");
    expect(findIn("git", ["/a", "/b"], (p) => p === hit, ["", ".exe"])).toBe(hit);
  });

  test("the bare name wins over a suffixed sibling in the same directory", () => {
    expect(findIn("git", ["/a"], () => true, ["", ".exe"])).toBe(join("/a", "git"));
  });

  test("PATH order still decides — an earlier dir's suffixed hit beats a later dir's bare one", () => {
    const earlierSuffixed = join("/a", "git.exe");
    const laterBare = join("/b", "git");
    expect(findIn("git", ["/a", "/b"], (p) => p === earlierSuffixed || p === laterBare, ["", ".exe"])).toBe(
      earlierSuffixed,
    );
  });
});

describe("toolExts", () => {
  // Off Windows there is no such thing as an executable suffix, so the search must not grow one:
  // a lone `""` keeps `findIn` doing exactly what it did before suffixes existed.
  // The platform is passed, never read: these ran on a Windows host only, which is a host we do
  // not have, so the branch they cover went untested on every machine that runs this suite.
  test("is the bare name alone off win32", () => {
    expect(toolExts({ PATHEXT: ".COM;.EXE" }, hostFor("linux"))).toEqual([""]);
  });

  test("is the bare name first, then PATHEXT, on win32", () => {
    expect(toolExts({ PATHEXT: ".COM;.EXE" }, hostFor("win32"))).toEqual(["", ".COM", ".EXE"]);
  });

  test("falls back to the standard suffixes with no PATHEXT", () => {
    expect(toolExts({}, hostFor("win32"))).toEqual(["", ".COM", ".EXE", ".BAT", ".CMD"]);
  });

  // Windows spells it `PathExt`, and case survives only while the environment is the live
  // `process.env` proxy — this module is handed plain copies of it.
  test("reads the name case-insensitively on win32", () => {
    expect(toolExts({ PathExt: ".COM;.EXE" }, hostFor("win32"))).toEqual(["", ".COM", ".EXE"]);
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
    expect(findTool("herdr", env, HOME, hostFor("win32"))).toBe(shim);
  });

  // Bun's compiler writes `collie.exe`; a caller holding the bare absolute path means that file. The
  // suffix is lowercase for the same reason as above: this runs on a case-sensitive filesystem.
  test("an absolute name without its suffix finds the file beside it, as `collie.exe` is found", () => {
    const exe = join(dir, "collie.exe");
    writeFileSync(exe, "MZ");
    chmodSync(exe, 0o755);
    expect(findTool(join(dir, "collie"), { PATHEXT: ".exe" }, HOME, hostFor("win32"))).toBe(exe);
    expect(findTool(join(dir, "collie"), { PATHEXT: ".exe" }, HOME, hostFor("linux"))).toBeNull();
    expect(findTool(join(dir, "nothing"), { PATHEXT: ".exe" }, HOME, hostFor("win32"))).toBeNull();
  });

  test("the same shim is not matched on linux — there the bare name is the only candidate", () => {
    expect(findTool("herdr", env, HOME, hostFor("linux"))).toBeNull();
  });
});
