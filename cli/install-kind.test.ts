import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolvePluginRoot } from "../bridge/root.ts";
import { fakeExec, fakeFiles, fakeLinkFs } from "./fakes.ts";
import {
  classifyInstall,
  detectInstall,
  type InstallProbe,
  originMatches,
  originOf,
  parseGithubRemote,
  probeInstall,
  publishedBinary,
  updateRepoOf,
} from "./install-kind.ts";
import { context } from "./fakes.ts";

// How Collie tells one install shape from another, and where it says its updates come from. The
// classifier is pure, so the whole truth table is here with no filesystem — including the degenerate
// cases, which are the ones a structural detection has to get right on purpose.

const probe = (over: Partial<InstallProbe> = {}): InstallProbe => ({
  isGitCheckout: false,
  isDetached: false,
  parentIsVersions: false,
  currentIsSymlink: false,
  currentResolvesHere: false,
  hasMarker: true,
  ...over,
});

describe("classifyInstall", () => {
  test("a clone on a branch is a linked clone; a detached one is the Herdr-managed shape", () => {
    expect(classifyInstall(probe({ isGitCheckout: true }))).toEqual({ kind: "linked-clone", alsoLayout: false });
    expect(classifyInstall(probe({ isGitCheckout: true, isDetached: true }))).toEqual({
      kind: "detached-checkout",
      alsoLayout: false,
    });
  });

  test("a versions/ parent with a `current` symlink resolving there is a binary install", () => {
    expect(
      classifyInstall(probe({ parentIsVersions: true, currentIsSymlink: true, currentResolvesHere: true })),
    ).toEqual({ kind: "binary" });
  });

  // The degenerate both-signals case, called out by the design review: a clone someone put inside a
  // versions/ layout. GIT WINS — a `.git` means a human put a working tree there, and the binary path
  // renames a version directory into `.trash/`, which is unrecoverable against uncommitted work.
  test("both signals: git wins, and the ambiguity is carried rather than hidden", () => {
    const both = probe({
      isGitCheckout: true,
      parentIsVersions: true,
      currentIsSymlink: true,
      currentResolvesHere: true,
    });
    expect(classifyInstall(both)).toEqual({ kind: "linked-clone", alsoLayout: true });
    expect(classifyInstall({ ...both, isDetached: true })).toEqual({
      kind: "detached-checkout",
      alsoLayout: true,
    });
  });

  test("a layout with no usable `current` is unknown, never guessed at", () => {
    expect(classifyInstall(probe({ parentIsVersions: true }))).toEqual({
      kind: "unknown",
      why: "orphan-layout",
    });
    // Present, but pointing somewhere else entirely — the same refusal.
    expect(classifyInstall(probe({ parentIsVersions: true, currentIsSymlink: true }))).toEqual({
      kind: "unknown",
      why: "orphan-layout",
    });
  });

  test("a loose binary and a tree with no manifest are both unknown, told apart by the marker", () => {
    expect(classifyInstall(probe())).toEqual({ kind: "unknown", why: "loose-binary" });
    expect(classifyInstall(probe({ hasMarker: false }))).toEqual({ kind: "unknown", why: "no-marker" });
  });
});

describe("probeInstall / detectInstall", () => {
  const ROOT = "/inst/versions/1.1.0";

  test("reads the layout off the `current` symlink and git off the checkout", () => {
    const deps = {
      ctx: context({}, { root: ROOT }),
      exec: fakeExec({ answers: [[`git -C ${ROOT} rev-parse --git-dir`, { code: 1 }]] }),
      files: fakeFiles({ [`${ROOT}/herdr-plugin.toml`]: 'version = "1.1.0"\n' }),
      link: fakeLinkFs({ "/inst/current": { kind: "symlink", target: ROOT } }),
    };
    expect(probeInstall(deps, ROOT)).toEqual({
      isGitCheckout: false,
      isDetached: false,
      parentIsVersions: true,
      currentIsSymlink: true,
      currentResolvesHere: true,
      hasMarker: true,
    });
    expect(detectInstall(deps)).toEqual({ kind: "binary" });
  });

  test("a `current` pointing outside the layout is not this install's", () => {
    const deps = {
      ctx: context({}, { root: ROOT }),
      exec: fakeExec({ answers: [[`git -C ${ROOT} rev-parse --git-dir`, { code: 1 }]] }),
      files: fakeFiles({}),
      link: fakeLinkFs({ "/inst/current": { kind: "symlink", target: "/somewhere/else" } }),
    };
    expect(detectInstall(deps)).toEqual({ kind: "unknown", why: "orphan-layout" });
  });
});

describe("publishedBinary — the PATH name is a pointer (ADR 0021)", () => {
  test("a binary install publishes `current/bin/collie`, so a flip needs no re-link", () => {
    const root = "/inst/versions/1.1.0";
    const link = fakeLinkFs({ "/inst/current": { kind: "symlink", target: root } });
    expect(publishedBinary(root, link)).toBe("/inst/current/bin/collie");
  });

  test("a checkout still publishes its own binary, byte for byte as before", () => {
    expect(publishedBinary("/src/collie", fakeLinkFs())).toBe("/src/collie/bin/collie");
    // A versions/ parent with no `current` is not a layout to point through.
    expect(publishedBinary("/inst/versions/1.1.0", fakeLinkFs())).toBe("/inst/versions/1.1.0/bin/collie");
  });
});

describe("where updates come from", () => {
  test("parseGithubRemote accepts every spelling git hands out, and only github.com", () => {
    for (const url of [
      "https://github.com/AltanS/collie.git",
      "https://github.com/AltanS/collie",
      "git@github.com:AltanS/collie.git",
      "ssh://git@github.com/AltanS/collie.git",
      "https://github.com/AltanS/collie/",
    ]) {
      expect(parseGithubRemote(url)).toBe("AltanS/collie");
    }
    expect(parseGithubRemote("/srv/mirrors/collie.git")).toBeNull();
    expect(parseGithubRemote("https://gitlab.com/AltanS/collie.git")).toBeNull();
    expect(parseGithubRemote("")).toBeNull();
  });

  test("COLLIE_UPDATE_REPO is the one override, and Collie's own repo is the default", () => {
    expect(updateRepoOf({})).toBe("AltanS/collie");
    expect(updateRepoOf({ COLLIE_UPDATE_REPO: "  my/collie  " })).toBe("my/collie");
    expect(updateRepoOf({ COLLIE_UPDATE_REPO: "" })).toBe("AltanS/collie");
  });

  test("originMatches normalises both sides — and an unreadable origin never matches", () => {
    const exec = fakeExec({
      answers: [["git -C /r remote get-url origin", { stdout: "git@github.com:AltanS/Collie.git\n" }]],
    });
    const origin = originOf(exec, "/r");
    expect(origin).toEqual({ kind: "repo", repo: "AltanS/Collie" });
    expect(originMatches(origin, "AltanS/collie")).toBe(true);
    expect(originMatches(origin, "youngsecurity/collie")).toBe(false);
    expect(originMatches({ kind: "unresolvable" }, "AltanS/collie")).toBe(false);
    // A non-GitHub remote can still be self-consistent for an operator who points both at it.
    expect(originMatches({ kind: "other", url: "/srv/collie.git" }, "/srv/collie")).toBe(true);
  });
});

// ── The assumption the whole no-skew guarantee rests on (M14/01 §1.3, §4.4) ───
// A binary started through `<root>/current/bin/collie` must report a REALPATH-RESOLVED
// `process.execPath`, so `resolvePluginRoot` returns `versions/X.Y.Z` and the running bridge stays
// pinned to the version directory it was launched from — serving that version's `web/dist` even
// after `current` has been flipped. If a future Bun stops resolving it, this test fails here rather
// than as a white screen on somebody's phone.
describe("process.execPath is realpath-resolved", () => {
  test("a process launched through a symlinked directory reports the real path", () => {
    const root = mkdtempSync(join(tmpdir(), "collie-execpath-"));
    try {
      const version = join(root, "versions", "1.1.0", "bin");
      mkdirSync(version, { recursive: true });
      // The running Bun, reached through BOTH a symlinked directory component and a symlinked name —
      // exactly the two indirections a binary install introduces.
      symlinkSync(process.execPath, join(version, "probe"));
      symlinkSync(join("versions", "1.1.0"), join(root, "current"));
      const r = Bun.spawnSync([join(root, "current", "bin", "probe"), "-e", "console.log(process.execPath)"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString().trim()).toBe(realpathSync(process.execPath));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolvePluginRoot turns that execPath into the versioned directory, never `current`", () => {
    const root = "/inst/versions/1.1.0";
    expect(
      resolvePluginRoot({
        env: {},
        execPath: `${root}/bin/collie`,
        source: null,
        exists: (p) => p === `${root}/herdr-plugin.toml`,
      }),
    ).toBe(root);
  });
});
