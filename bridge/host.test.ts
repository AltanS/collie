import { describe, expect, test } from "bun:test";
import { posix, win32 } from "node:path";

import {
  binaryName,
  collieBinary,
  foldName,
  HOST,
  hostFor,
  isBelow,
  isInside,
  isSameOrInside,
  splitPath,
} from "./host.ts";

const WIN = hostFor("win32");
const LINUX = hostFor("linux");

describe("hostFor", () => {
  test("win32 reads Windows paths and names executables with .exe", () => {
    expect(WIN).toEqual({ platform: "win32", path: win32, exeSuffix: ".exe", caseInsensitive: true });
  });

  test("every other platform reads POSIX paths, and keeps its own name", () => {
    expect(LINUX).toEqual({ platform: "linux", path: posix, exeSuffix: "", caseInsensitive: false });
    // macOS disks fold case, but the checks never did: the answer there stays exact.
    expect(hostFor("darwin")).toEqual({ platform: "darwin", path: posix, exeSuffix: "", caseInsensitive: false });
    expect(hostFor("freebsd").path).toBe(posix);
  });

  test("the same name gives the same object", () => {
    expect(hostFor("win32")).toBe(hostFor("win32"));
    expect(hostFor("linux")).toBe(hostFor("linux"));
    expect(hostFor("darwin")).not.toBe(hostFor("linux"));
  });

  test("HOST is this machine", () => {
    expect(HOST).toBe(hostFor(process.platform));
  });
});

describe("binaryName and collieBinary", () => {
  test("a Windows root gets collie.exe, joined the Windows way", () => {
    expect(binaryName(WIN)).toBe("collie.exe");
    expect(collieBinary("C:\\Users\\x\\collie", WIN)).toBe("C:\\Users\\x\\collie\\bin\\collie.exe");
    expect(collieBinary("C:/Users/x/collie", WIN)).toBe("C:\\Users\\x\\collie\\bin\\collie.exe");
  });

  test("a POSIX root gets a bare collie", () => {
    expect(binaryName(LINUX)).toBe("collie");
    expect(collieBinary("/opt/collie", LINUX)).toBe("/opt/collie/bin/collie");
    expect(collieBinary("/opt/collie", hostFor("darwin"))).toBe("/opt/collie/bin/collie");
  });
});

describe("splitPath and foldName", () => {
  test("Windows cuts a drive, a share and an extended prefix, with either slash", () => {
    expect(splitPath(WIN, "C:/Users//pat\\x")).toEqual({ root: "C:\\", parts: ["Users", "pat", "x"] });
    expect(splitPath(WIN, "\\\\?\\C:\\Users")).toEqual({ root: "C:\\", parts: ["Users"] });
    expect(splitPath(WIN, "\\\\?\\UNC\\srv\\share\\a")).toEqual({ root: "\\\\srv\\share\\", parts: ["a"] });
  });

  test("POSIX cuts at slashes only; a backslash is a name character", () => {
    expect(splitPath(LINUX, "/a//b/")).toEqual({ root: "/", parts: ["a", "b"] });
    expect(splitPath(LINUX, "/a\\b")).toEqual({ root: "/", parts: ["a\\b"] });
  });

  test("only Windows folds case", () => {
    expect(foldName(WIN, "AbC")).toBe("abc");
    expect(foldName(LINUX, "AbC")).toBe("AbC");
  });
});

describe("isInside, isSameOrInside and isBelow", () => {
  test("POSIX is exact: case counts, a longer sibling name is outside, equal is inside", () => {
    expect(isInside(LINUX, "/a/b/c", "/a/b")).toBe(true);
    expect(isInside(LINUX, "/a/b", "/a/b")).toBe(true);
    expect(isInside(LINUX, "/a/bc", "/a/b")).toBe(false);
    expect(isInside(LINUX, "/a/B/c", "/a/b")).toBe(false);
    expect(isInside(LINUX, "/a", "/a/b")).toBe(false);
    expect(isInside(LINUX, "/anything", "/")).toBe(true);
  });

  test("Windows folds case and either slash, and never crosses a drive or share", () => {
    expect(isInside(WIN, "c:\\users\\pat\\x", "C:\\Users\\Pat")).toBe(true);
    expect(isInside(WIN, "C:/Users/Pat/x", "C:\\Users\\Pat")).toBe(true);
    expect(isInside(WIN, "\\\\?\\C:\\Users\\Pat\\x", "C:\\Users\\Pat")).toBe(true);
    expect(isInside(WIN, "D:\\Users\\Pat\\x", "C:\\Users\\Pat")).toBe(false);
    expect(isInside(WIN, "C:\\Users\\Patrick", "C:\\Users\\Pat")).toBe(false);
    expect(isInside(WIN, "\\\\srv\\other\\a", "\\\\srv\\share")).toBe(false);
  });

  test("isSameOrInside is isInside with parent first", () => {
    expect(isSameOrInside(LINUX, "/a/b", "/a/b/c")).toBe(true);
    expect(isSameOrInside(LINUX, "/a/b", "/a/b")).toBe(true);
    expect(isSameOrInside(LINUX, "/a/b", "/a")).toBe(false);
    expect(isSameOrInside(WIN, "C:\\A", "c:\\a\\b")).toBe(true);
  });

  test("isBelow leaves out the folder itself", () => {
    expect(isBelow(LINUX, "/a/b", "/a/b/c")).toBe(true);
    expect(isBelow(LINUX, "/a/b", "/a/b")).toBe(false);
    expect(isBelow(LINUX, "/a/b", "/a/b/")).toBe(false);
    expect(isBelow(LINUX, "/a/b", "/a/bc")).toBe(false);
    expect(isBelow(WIN, "C:\\A", "c:\\a")).toBe(false);
    expect(isBelow(WIN, "C:\\A", "c:\\a\\b")).toBe(true);
  });
});
