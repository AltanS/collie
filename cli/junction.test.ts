import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { realLinkFs } from "./link.ts";
import { realFiles } from "./sys.ts";

// REAL FILES, on purpose: the promise is that removing `current` never deletes the version it names,
// and only a real filesystem can break it. On Windows (CI and the VM) these make real directory
// junctions; on Linux and macOS `"junction"` is ignored and the same calls make a directory symlink,
// which must obey the same rule.

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An install root with `versions/1.0.0/sentinel` and `current` naming that folder. */
interface Install {
  readonly root: string;
  readonly target: string;
  readonly current: string;
  readonly sentinel: string;
}

function install(): Install {
  const root = mkdtempSync(join(tmpdir(), "collie-junction-"));
  made.push(root);
  const target = join(root, "versions", "1.0.0");
  mkdirSync(target, { recursive: true });
  const sentinel = join(target, "sentinel");
  writeFileSync(sentinel, "still here");
  const current = join(root, "current");
  realLinkFs.junction(target, current);
  return { root, target, current, sentinel };
}

describe("the junction `current` is", () => {
  test("read as a link that names its folder", () => {
    const at = install();
    const probe = realLinkFs.probe(at.current);
    expect(probe.kind).toBe("symlink");
    expect(probe.kind === "symlink" ? probe.target : null).toBe(at.target);
    expect(readFileSync(join(at.current, "sentinel"), "utf8")).toBe("still here");
  });

  test("removed by itself: the folder it names and the file in it survive", () => {
    const at = install();
    realLinkFs.remove(at.current);
    expect(existsSync(at.current)).toBe(false);
    expect(readFileSync(at.sentinel, "utf8")).toBe("still here");
  });

  test("removed with the folder that holds it, and the folder it names survives (the prune path)", () => {
    // `pruneVersions` and the binary prune (`toTrash`) both end in `removeTree` on a version folder.
    // A folder that holds a junction must lose the junction and keep what it names.
    const at = install();
    const doomed = join(at.root, "versions", "0.9.0");
    mkdirSync(doomed, { recursive: true });
    symlinkSync(at.target, join(doomed, "inner"), "junction");
    realFiles.removeTree(doomed);
    expect(existsSync(doomed)).toBe(false);
    expect(readFileSync(at.sentinel, "utf8")).toBe("still here");
    expect(lstatSync(at.target).isDirectory()).toBe(true);
  });

  test("a missing name is no error, and a real folder is refused, not emptied", () => {
    const at = install();
    expect(() => realLinkFs.remove(join(at.root, "nothing-here"))).not.toThrow();
    expect(() => realLinkFs.remove(at.target)).toThrow();
    expect(readFileSync(at.sentinel, "utf8")).toBe("still here");
  });
});
