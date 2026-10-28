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
  surfacePlatform,
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

  test("a host cannot be changed, so one test cannot poison the next", () => {
    expect(Object.isFrozen(hostFor("win32"))).toBe(true);
    expect(() => {
      // SAFETY: the cast drops `readonly` on purpose, to prove the frozen object refuses the write.
      (hostFor("linux") as { exeSuffix: string }).exeSuffix = ".exe";
    }).toThrow();
    expect(hostFor("linux").exeSuffix).toBe("");
  });
});

describe("surfacePlatform", () => {
  // Real /proc/version lines: WSL1 (Microsoft with a capital M), WSL2 (microsoft-standard-WSL2) and Fedora.
  const WSL1 = "Linux version 4.4.0-19041-Microsoft (Microsoft@Microsoft.com) (gcc version 5.4.0 (GCC) ) #1237-Microsoft Sat Sep 11 14:32:00 PST 2021";
  const WSL2 = "Linux version 5.15.153.1-microsoft-standard-WSL2 (root@941d701f84f1) (gcc (GCC) 11.2.0, GNU ld (GNU Binutils) 2.37) #1 SMP Fri Mar 29 23:14:13 UTC 2024";
  const FEDORA = "Linux version 6.11.4-301.fc41.x86_64 (mockbuild@d4b8f2a1c3e84f2f8a7d6c5b4e3f2a10) (gcc (GCC) 14.2.1 20240912 (Red Hat 14.2.1-3), GNU ld version 2.43.1-2.fc41) #1 SMP PREEMPT_DYNAMIC Tue Oct 15 14:47:03 UTC 2024";
  const source = (platform: string, env: Record<string, string> = {}, procVersion: string | null = FEDORA) => ({
    platform,
    env,
    readProcVersion: () => procVersion,
  });

  test("a WSL1 /proc/version line is WSL", () => {
    expect(surfacePlatform(source("linux", {}, WSL1))).toBe("wsl");
  });

  test("a WSL2 /proc/version line is WSL", () => {
    expect(surfacePlatform(source("linux", {}, WSL2))).toBe("wsl");
  });

  test("a plain Fedora /proc/version line is Linux", () => {
    expect(surfacePlatform(source("linux", {}, FEDORA))).toBe("linux");
    expect(surfacePlatform(source("linux", {}, null))).toBe("linux");
  });

  test("WSL_DISTRO_NAME or WSL_INTEROP alone is WSL, with a plain /proc/version", () => {
    expect(surfacePlatform(source("linux", { WSL_DISTRO_NAME: "Ubuntu" }, FEDORA))).toBe("wsl");
    expect(surfacePlatform(source("linux", { WSL_INTEROP: "/run/WSL/8_interop" }, FEDORA))).toBe("wsl");
    expect(surfacePlatform(source("linux", { WSL_DISTRO_NAME: "" }, FEDORA))).toBe("linux");
  });

  test("win32 stays win32, whatever the signals say", () => {
    expect(surfacePlatform(source("win32", { WSL_DISTRO_NAME: "Ubuntu" }, WSL2))).toBe("win32");
    expect(surfacePlatform(source("darwin", {}, WSL2))).toBe("darwin");
  });

  test("the env settles it without reading /proc/version", () => {
    let reads = 0;
    const answer = surfacePlatform({ platform: "linux", env: { WSL_INTEROP: "/run/WSL/1_interop" }, readProcVersion: () => { reads += 1; return null; } });
    expect(answer).toBe("wsl");
    expect(reads).toBe(0);
  });
});
