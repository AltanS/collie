import { describe, expect, test } from "bun:test";

import { classifyExe, exePathOf, exeReplaced, type ExeEvidence } from "./exe-replaced.ts";

// The case this module exists for, from a real Arch VM: `pacman -U` of a rebuilt `collie-bin` under
// a running bridge leaves the service on a deleted inode, serving the old code, while the version
// files on disk describe the new build. A same-version rebuild moves no version string at all, so
// the only thing that can notice it is the executable.

const NOTHING: ExeEvidence = {
  exeLink: null,
  exeInode: null,
  installedInode: null,
  installedMtimeMs: null,
  startedAtMs: null,
};

const evidence = (over: Partial<ExeEvidence>): ExeEvidence => ({ ...NOTHING, ...over });

describe("the deleted marker is taken at its word", () => {
  test("a `(deleted)` link is replaced, whatever else was probed", () => {
    expect(
      classifyExe(
        evidence({
          exeLink: "/opt/collie/bin/collie (deleted)",
          exeInode: 111,
          installedInode: 111,
          installedMtimeMs: 1,
          startedAtMs: 2,
        }),
      ),
    ).toBe("replaced");
  });

  test("a plain link on its own proves nothing", () => {
    expect(classifyExe(evidence({ exeLink: "/opt/collie/bin/collie" }))).toBe("unknown");
  });

  test("the path is readable with the marker off it, and unchanged without one", () => {
    expect(exePathOf("/opt/collie/bin/collie (deleted)")).toBe("/opt/collie/bin/collie");
    expect(exePathOf("/opt/collie/bin/collie")).toBe("/opt/collie/bin/collie");
    expect(exePathOf(null)).toBeNull();
  });
});

describe("two inodes decide when the path still resolves", () => {
  test("a package manager that wrote a new file at the same path reads as replaced", () => {
    const ev = evidence({ exeLink: "/opt/collie/bin/collie", exeInode: 111, installedInode: 222 });
    expect(classifyExe(ev)).toBe("replaced");
    expect(exeReplaced(ev)).toBe(true);
  });

  test("the same inode is current, and a stale mtime does not override it", () => {
    const ev = evidence({
      exeLink: "/opt/collie/bin/collie",
      exeInode: 111,
      installedInode: 111,
      installedMtimeMs: 9_000,
      startedAtMs: 1_000,
    });
    expect(classifyExe(ev)).toBe("current");
    expect(exeReplaced(ev)).toBe(false);
  });
});

describe("mtime against the process start is the fallback, and only that", () => {
  test("a file written after the process started reads as replaced", () => {
    expect(classifyExe(evidence({ installedMtimeMs: 2_000, startedAtMs: 1_000 }))).toBe("replaced");
  });

  test("a file older than the process is the one it is running", () => {
    expect(classifyExe(evidence({ installedMtimeMs: 1_000, startedAtMs: 2_000 }))).toBe("current");
  });

  test("one half of the pair is not an answer", () => {
    expect(classifyExe(evidence({ installedMtimeMs: 2_000 }))).toBe("unknown");
    expect(classifyExe(evidence({ startedAtMs: 2_000 }))).toBe("unknown");
  });
});

describe("no evidence is `unknown`, never `current`", () => {
  test("an empty probe declines to answer", () => {
    expect(classifyExe(NOTHING)).toBe("unknown");
    expect(exeReplaced(NOTHING)).toBe(false);
  });
});
