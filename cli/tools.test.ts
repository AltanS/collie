import { describe, expect, test } from "bun:test";

import { fallbackDirs, findIn, searchDirs } from "./tools.ts";

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
});
