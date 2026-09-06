import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolvePluginRoot } from "../bridge/root.ts";
import { fakeExec, fakeFiles, fakeLinkFs, HOME } from "./fakes.ts";
import { realFiles } from "./sys.ts";
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
  rootOwnerUid: 1000,
  rootIsReadOnly: false,
  rootOutsideHome: false,
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
      rootOwnerUid: 1000,
      rootIsReadOnly: false,
      rootOutsideHome: true,
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

// ── The install nobody here can update ───────────────────────────────────────
// A package manager lays Collie down in a folder it owns, and updates that folder itself. The
// predicate has four clauses and the fourth is a DISJUNCTION of three probed facts, because no one
// of them covers every packager: the Nix store is read-only, Homebrew's prefix is writable and
// outside `$HOME`, and a tarball unpacked as root is inside `$HOME` and owned by uid 0.
//
// Before this kind existed every one of those shapes fell out as `unknown`/`loose-binary`, and
// `collie update` told operators their perfectly ordinary packaged install was unrecognisable.

describe("classifyInstall — a folder a package manager owns", () => {
  test("clause 4 is satisfied by read-only ALONE — the Nix store's shape", () => {
    expect(classifyInstall(probe({ rootIsReadOnly: true }))).toEqual({ kind: "packaged" });
  });

  test("clause 4 is satisfied by outside-$HOME ALONE — Homebrew's shape", () => {
    // The disjunct that carries Homebrew, and the reason read-only is not enough on its own:
    // `/opt/homebrew` is writable by the operator who installed it and is still not their folder.
    expect(
      classifyInstall(probe({ rootOutsideHome: true, rootIsReadOnly: false, rootOwnerUid: 1000 })),
    ).toEqual({ kind: "packaged" });
  });

  test("clause 4 is satisfied by root ownership ALONE — a tree unpacked as root inside $HOME", () => {
    // And the reason ownership survives alongside the other two: `access(2)` is always true for uid
    // 0, so a bridge probing its own root AS root reads `writable` and would otherwise see nothing.
    expect(classifyInstall(probe({ rootOwnerUid: 0 }))).toEqual({ kind: "packaged" });
  });

  test("a writable, user-owned marker tree inside $HOME is still the loose binary we cannot name", () => {
    // All three disjuncts false. The closed direction: Collie declines to update what it cannot
    // describe rather than claiming a package manager that may not exist.
    expect(classifyInstall(probe())).toEqual({ kind: "unknown", why: "loose-binary" });
  });

  test("an unreadable owner claims nothing on its own — null is not root", () => {
    // `stat` failed. Nothing could be read, so nothing may be asserted, and a probe that could not
    // answer read-only reads `false` for the same reason.
    expect(classifyInstall(probe({ rootOwnerUid: null }))).toEqual({ kind: "unknown", why: "loose-binary" });
  });

  test("no marker is not a Collie at all — clause 3 is asked before clause 4", () => {
    // /usr/lib/something-else is not a Collie whose updates belong to pacman, it is a directory that
    // is not a Collie. Claiming it would make `collie update` explain package management to someone
    // who ran it in the wrong place.
    for (const over of [{ rootOwnerUid: 0 }, { rootIsReadOnly: true }, { rootOutsideHome: true }]) {
      expect(classifyInstall(probe({ ...over, hasMarker: false }))).toEqual({
        kind: "unknown",
        why: "no-marker",
      });
    }
  });

  test("layout outranks clause 4: a checkout and a binary install keep their kind", () => {
    // Clauses 1 and 2 are asked first. A read-only, root-owned clone is still a clone, and the same
    // versions/ layout is still a binary install — reading clause 4 earlier would silently
    // reclassify a working install the moment someone chowned it or moved it out of $HOME.
    const owned = { rootOwnerUid: 0, rootIsReadOnly: true, rootOutsideHome: true } as const;
    expect(classifyInstall(probe({ isGitCheckout: true, ...owned }))).toEqual({
      kind: "linked-clone",
      alsoLayout: false,
    });
    expect(classifyInstall(probe({ isGitCheckout: true, isDetached: true, ...owned }))).toEqual({
      kind: "detached-checkout",
      alsoLayout: false,
    });
    expect(
      classifyInstall(
        probe({ parentIsVersions: true, currentIsSymlink: true, currentResolvesHere: true, ...owned }),
      ),
    ).toEqual({ kind: "binary" });
  });

  test("probeInstall asks the filesystem, and detectInstall carries the answer through", () => {
    const ROOT = "/usr/lib/collie";
    const files = fakeFiles({ [`${ROOT}/herdr-plugin.toml`]: 'version = "1.5.3"\n' });
    files.rootOwned.add(ROOT);
    files.readOnly.add(ROOT);
    const deps = {
      ctx: context({}, { root: ROOT }),
      exec: fakeExec({ answers: [[`git -C ${ROOT} rev-parse --git-dir`, { code: 128 }]] }),
      files,
      link: fakeLinkFs(),
    };
    const p = probeInstall(deps, ROOT);
    expect(p.rootOwnerUid).toBe(0);
    expect(p.rootIsReadOnly).toBe(true);
    expect(p.rootOutsideHome).toBe(true);
    expect(detectInstall(deps)).toEqual({ kind: "packaged" });
  });

  test("the Homebrew shape end to end: writable, user-owned, outside $HOME", () => {
    // The one a read-only-or-root-owned predicate would have missed entirely.
    const ROOT = "/opt/homebrew/Cellar/collie/1.5.3";
    const files = fakeFiles({ [`${ROOT}/herdr-plugin.toml`]: 'version = "1.5.3"\n' });
    const deps = {
      ctx: context({}, { root: ROOT }),
      exec: fakeExec({ answers: [[`git -C ${ROOT} rev-parse --git-dir`, { code: 128 }]] }),
      files,
      link: fakeLinkFs(),
    };
    const p = probeInstall(deps, ROOT);
    expect(p.rootIsReadOnly).toBe(false);
    expect(p.rootOwnerUid).toBe(1000);
    expect(p.rootOutsideHome).toBe(true);
    expect(detectInstall(deps)).toEqual({ kind: "packaged" });
  });

  test("a marker tree INSIDE $HOME that is writable and the operator's own is not packaged", () => {
    const ROOT = `${HOME}/collie-unpacked`;
    const files = fakeFiles({ [`${ROOT}/herdr-plugin.toml`]: 'version = "1.5.3"\n' });
    const deps = {
      ctx: context({}, { root: ROOT }),
      exec: fakeExec({ answers: [[`git -C ${ROOT} rev-parse --git-dir`, { code: 128 }]] }),
      files,
      link: fakeLinkFs(),
    };
    expect(probeInstall(deps, ROOT).rootOutsideHome).toBe(false);
    expect(detectInstall(deps)).toEqual({ kind: "unknown", why: "loose-binary" });
  });
});

// ── ownerUid on a platform with no POSIX ownership ────────────────────────────
// Node/Bun's `stat().uid` reports a constant 0 on win32 regardless of who owns the file — that is
// "this platform has no such concept", not "root owns it", and the two must not collide: Collie
// supports win32 (bridge/config.ts, bridge/dial.ts), and colliding them would make an ordinary
// win32 install answer uid 0 and refuse to update forever.

describe("realFiles.ownerUid — win32 has no uid to report", () => {
  const original = process.platform;
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  });

  test("win32 answers null, never 0, whatever stat() would say", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-owner-"));
    try {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      expect(realFiles.ownerUid(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("off win32, a real directory answers its real stat().uid", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-owner-"));
    try {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      expect(realFiles.ownerUid(dir)).toBe(statSync(dir).uid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a path that does not exist answers null, not an exception", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    expect(realFiles.ownerUid("/no/such/path/at/all")).toBeNull();
  });
});
