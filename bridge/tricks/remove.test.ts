import { afterAll, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST } from "../host.ts";
import { approveFolder, FOLDER_GONE_LINE, forgetLeftovers } from "./approved.ts";
import { diskTrickFs, type TrickFs } from "./code-hash.ts";
import { makeFoldersUnder } from "./proposal-install.ts";
import { ASIDE_COMMITS_DIR, asideCommitPath, commitAside, GONE_PREFIX, moveAside, newAsideToken, sweepGone } from "./aside.ts";
import { createTrickScanner } from "./discover.ts";
import { APPROVED_DIR, PENDING_DIR, switchesPath, TRICKS_DIR, tricksStateDir, trickStateDir } from "./paths.ts";
import { clearRunMarks, markRun, REMOVE_LINK_LINE, REMOVE_ON_LINE, REMOVE_RUNNING_LINE, removeTrick, RemoveUnreadable, RUN_MARK_MAX_MS, runMarked, runMarkPath, unmarkRun } from "./remove.ts";
import { parseSwitches, updateSwitchesFor, withSwitch, writeSwitches } from "./switches.ts";

// ADR 0168: the one function `collie trick remove` and the bridge's remove route call. Every refusal is proven to
// delete nothing: each test asserts the folders it made are still there. Every trick is made in a temp folder.

const posix = !HOST.caseInsensitive && process.platform !== "win32";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-trick-remove-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  for (const d of dirs) await chmod(join(d, "state", TRICKS_DIR), 0o700).catch(() => {});
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

interface Setup {
  root: string;
  configDir: string;
  stateDir: string;
  /** The four places of `legs`. */
  folder: string;
  state: string;
  approved: string;
  pending: string;
  /** A second trick that must never be touched. */
  other: string;
}

async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) !== null;
}

/** `legs` with all four places filled, `other` beside it, and a switch file that holds `other` on. */
async function setup(): Promise<Setup> {
  const root = await tempDir();
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  const tricks = join(configDir, TRICKS_DIR);
  const folder = join(tricks, "legs");
  const state = trickStateDir(stateDir, "legs");
  const approved = join(tricks, APPROVED_DIR, "legs");
  const pending = join(tricks, PENDING_DIR, "legs");
  const other = join(tricks, "other");
  for (const dir of [folder, state, join(approved, "aaaaaaaaaaaaaaaa"), join(pending, "bbbbbbbbbbbbbbbb"), other, trickStateDir(stateDir, "other"), join(tricks, APPROVED_DIR, "other", "cccccccccccccccc")]) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "x.txt"), "x\n");
  }
  await writeSwitches(stateDir, withSwitch({ on: new Map() }, "other", true, "2026-11-21T09:00:00Z", "c".repeat(64)));
  return { root, configDir, stateDir, folder, state, approved, pending, other };
}

/** Every place of `legs` and of `other` is still there. */
async function untouched(s: Setup): Promise<void> {
  for (const path of [s.folder, s.state, s.approved, s.pending, s.other, trickStateDir(s.stateDir, "other")]) {
    expect({ path, there: await exists(path) }).toEqual({ path, there: true });
  }
}

const idle = (): boolean => false;

/** Every `.gone-*` name in the four parents, and every commit file. */
async function asides(s: Setup): Promise<string[]> {
  const out: string[] = [];
  for (const parent of [join(s.configDir, TRICKS_DIR), tricksStateDir(s.stateDir), join(s.configDir, TRICKS_DIR, APPROVED_DIR), join(s.configDir, TRICKS_DIR, PENDING_DIR), join(tricksStateDir(s.stateDir), ASIDE_COMMITS_DIR)]) {
    for (const name of await readdir(parent).catch(() => [])) if (name.startsWith(GONE_PREFIX) || parent.endsWith(ASIDE_COMMITS_DIR)) out.push(join(parent, name));
  }
  return out;
}

describe.if(posix)("removeTrick: what goes", () => {
  test("a trick that is off: its folder, its state folder and its copies go; forget runs once; nothing else moves", async () => {
    const s = await setup();
    const forgot: string[] = [];
    const out = await removeTrick({ configDir: s.configDir, stateDir: s.stateDir, id: "legs", busy: idle, forget: (id) => void forgot.push(id) });
    expect(out).toEqual({ ok: true, folder: s.folder, state: s.state, leftovers: [], forgot: true });
    for (const path of [s.folder, s.state, s.approved, s.pending]) expect(await exists(path)).toBe(false);
    expect(await asides(s)).toEqual([]);
    expect(forgot).toEqual(["legs"]);
    // The other trick, its state, its copy and its switch entry stay; no `.gone-*` is left behind.
    expect(await exists(join(s.other, "x.txt"))).toBe(true);
    expect(await exists(join(s.configDir, TRICKS_DIR, APPROVED_DIR, "other", "cccccccccccccccc"))).toBe(true);
    expect(parseSwitches(await readFile(switchesPath(s.stateDir), "utf8")).switches.on.has("other")).toBe(true);
    for (const parent of [join(s.configDir, TRICKS_DIR), tricksStateDir(s.stateDir), join(s.configDir, TRICKS_DIR, APPROVED_DIR), join(s.configDir, TRICKS_DIR, PENDING_DIR)]) {
      expect((await readdir(parent)).filter((n) => n.startsWith(GONE_PREFIX))).toEqual([]);
    }
  });

  test("a trick with no state folder and no copies is removed too", async () => {
    const s = await setup();
    await rm(s.state, { recursive: true });
    await rm(s.approved, { recursive: true });
    await rm(s.pending, { recursive: true });
    expect((await removeTrick({ configDir: s.configDir, stateDir: s.stateDir, id: "legs", busy: idle })).ok).toBe(true);
    expect(await exists(s.folder)).toBe(false);
  });

  test("after the commit a forget that throws is logged: the answer is removed and the deletes still run", async () => {
    const s = await setup();
    const warned: string[] = [];
    const out = await removeTrick({ configDir: s.configDir, stateDir: s.stateDir, id: "legs", busy: idle, warn: (l) => void warned.push(l), forget: () => { throw new Error("views"); } });
    expect(out).toEqual({ ok: true, folder: s.folder, state: s.state, leftovers: [], forgot: false });
    expect(warned.join("\n")).toContain("views");
    for (const path of [s.folder, s.state, s.approved, s.pending]) expect(await exists(path)).toBe(false);
    expect(await asides(s)).toEqual([]);
  });

  test("after the commit a delete that fails is a leftover: removed, logged, and the next start deletes it", async () => {
    const s = await setup();
    const warned: string[] = [];
    // The forget runs after the commit and before the deletes: it locks the state folder's parent, so that delete fails.
    const out = await removeTrick({ configDir: s.configDir, stateDir: s.stateDir, id: "legs", busy: idle, warn: (l) => void warned.push(l), forget: async () => await chmod(tricksStateDir(s.stateDir), 0o500) });
    await chmod(tricksStateDir(s.stateDir), 0o700);
    if (!out.ok) throw new Error("refused");
    expect(out.leftovers).toHaveLength(1);
    expect(out.leftovers[0]?.startsWith(join(tricksStateDir(s.stateDir), `${GONE_PREFIX}legs-`))).toBe(true);
    for (const path of [s.folder, s.approved, s.pending]) expect(await exists(path)).toBe(false);
    expect(warned.join("\n")).toContain("the next start deletes it");
    // The batch stays committed while an aside is left; the sweep deletes it and its commit file.
    expect(await sweepGone({ stateDir: s.stateDir, configDir: s.configDir })).toEqual({ removed: 1, restored: 0, kept: 0 });
    expect(await asides(s)).toEqual([]);
    expect(await exists(s.state)).toBe(false);
  });

  test("a trick whose folder is gone but whose other places are there is removed: the leftovers go", async () => {
    const s = await setup();
    await rm(s.folder, { recursive: true });
    const out = await removeTrick({ configDir: s.configDir, stateDir: s.stateDir, id: "legs", busy: idle });
    expect(out.ok).toBe(true);
    for (const path of [s.state, s.approved, s.pending]) expect(await exists(path)).toBe(false);
    expect(await exists(s.other)).toBe(true);
  });
});

describe.if(posix)("removeTrick: the id is a name, never a path", () => {
  for (const id of ["..", "../legs", "/etc", join("/", "tmp", "legs"), "legs/../other", "a/b", "a%2Fb", "a\\b", ".collie-approved", ".gone-legs-aaaaaaaaaaaa", "", "legs\0"]) {
    test(`${JSON.stringify(id)} is no trick and deletes nothing`, async () => {
      const s = await setup();
      const out = await removeTrick({ configDir: s.configDir, stateDir: s.stateDir, id, busy: idle });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.code).toBe("unknown-trick");
      await untouched(s);
    });
  }

  test("an id with no folder deletes nothing", async () => {
    const s = await setup();
    const out = await removeTrick({ configDir: s.configDir, stateDir: s.stateDir, id: "nope", busy: idle });
    expect(out).toEqual({ ok: false, code: "unknown-trick", message: "There is no trick nope." });
    await untouched(s);
  });
});

describe.if(posix)("removeTrick: a link or a file in a place refuses the whole remove", () => {
  async function outside(s: Setup): Promise<string> {
    const target = join(s.root, "elsewhere");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "keep.txt"), "keep\n");
    return target;
  }

  async function refusedAndKept(s: Setup, target: string | null): Promise<void> {
    const out = await removeTrick({ configDir: s.configDir, stateDir: s.stateDir, id: "legs", busy: idle });
    expect(out).toEqual({ ok: false, code: "link", message: REMOVE_LINK_LINE });
    if (target !== null) expect(await readFile(join(target, "keep.txt"), "utf8")).toBe("keep\n");
  }

  test("a symlinked trick folder", async () => {
    const s = await setup();
    const target = await outside(s);
    await rm(s.folder, { recursive: true });
    await symlink(target, s.folder);
    await refusedAndKept(s, target);
    expect((await lstat(s.folder)).isSymbolicLink()).toBe(true);
    for (const path of [s.state, s.approved, s.pending]) expect(await exists(path)).toBe(true);
  });

  test("a file in place of the trick folder", async () => {
    const s = await setup();
    await rm(s.folder, { recursive: true });
    await writeFile(s.folder, "not a folder\n");
    await refusedAndKept(s, null);
    expect(await readFile(s.folder, "utf8")).toBe("not a folder\n");
  });

  test("a symlinked state folder", async () => {
    const s = await setup();
    const target = await outside(s);
    await rm(s.state, { recursive: true });
    await symlink(target, s.state);
    await refusedAndKept(s, target);
    expect((await lstat(s.state)).isSymbolicLink()).toBe(true);
    for (const path of [s.folder, s.approved, s.pending]) expect(await exists(path)).toBe(true);
  });

  test("a symlinked approved copy and a symlinked pending folder", async () => {
    for (const which of ["approved", "pending"] as const) {
      const s = await setup();
      const target = await outside(s);
      await rm(s[which], { recursive: true });
      await symlink(target, s[which]);
      await refusedAndKept(s, target);
      for (const path of [s.folder, s.state]) expect(await exists(path)).toBe(true);
    }
  });

  test("a `.collie-approved` folder that is a link pointing out", async () => {
    const s = await setup();
    const target = await outside(s);
    const copies = join(s.configDir, TRICKS_DIR, APPROVED_DIR);
    await mkdir(join(target, "legs"), { recursive: true });
    await rm(copies, { recursive: true });
    await symlink(target, copies);
    await refusedAndKept(s, target);
    expect(await exists(join(target, "legs"))).toBe(true);
    expect(await exists(s.folder)).toBe(true);
  });

  test("a tricks folder that is itself a link is followed as the base: the trick inside it is removed, nothing outside", async () => {
    // A person may keep the config folder on another disk; the real base is resolved, and the place must lie in it.
    const s = await setup();
    const moved = join(s.root, "moved-tricks");
    const tricks = join(s.configDir, TRICKS_DIR);
    await rename(tricks, moved);
    await symlink(moved, tricks);
    expect((await removeTrick({ configDir: s.configDir, stateDir: s.stateDir, id: "legs", busy: idle })).ok).toBe(true);
    expect(await exists(join(moved, "legs"))).toBe(false);
    expect(await exists(join(moved, "other"))).toBe(true);
  });
});

describe.if(posix)("removeTrick: only while it is off and no run goes", () => {
  test("a trick that is on is refused and nothing is deleted", async () => {
    const s = await setup();
    await writeSwitches(s.stateDir, withSwitch({ on: new Map() }, "legs", true, "2026-11-21T09:00:00Z", "a".repeat(64)));
    const out = await removeTrick({ configDir: s.configDir, stateDir: s.stateDir, id: "legs", busy: idle });
    expect(out).toEqual({ ok: false, code: "on", message: REMOVE_ON_LINE });
    await untouched(s);
  });

  test("a run going is refused and nothing is deleted; busy is asked while the switch file's lock is held", async () => {
    const s = await setup();
    let locked: boolean | null = null;
    const busy = (id: string): boolean => {
      locked = Bun.file(`${switchesPath(s.stateDir)}.lock`).size > 0;
      return id === "legs";
    };
    const out = await removeTrick({ configDir: s.configDir, stateDir: s.stateDir, id: "legs", busy });
    expect(out).toEqual({ ok: false, code: "running", message: REMOVE_RUNNING_LINE });
    expect(locked === true).toBe(true);
    await untouched(s);
  });

  test("a rename that fails half way puts back what moved, and the trick stays whole", async () => {
    const s = await setup();
    // The state folder's parent refuses the rename: the trick folder moved first and must come back.
    await chmod(tricksStateDir(s.stateDir), 0o500);
    try {
      // The lock file lives in the same folder, so the lock itself fails first on some systems: either way nothing goes.
      await expect(removeTrick({ configDir: s.configDir, stateDir: s.stateDir, id: "legs", busy: idle })).rejects.toThrow();
    } finally {
      await chmod(tricksStateDir(s.stateDir), 0o700);
    }
    await untouched(s);
    expect((await readdir(join(s.configDir, TRICKS_DIR))).filter((n) => n.startsWith(GONE_PREFIX))).toEqual([]);
  });

  test("a rename of a copy that fails puts back the folder and the state folder", async () => {
    const s = await setup();
    const copies = join(s.configDir, TRICKS_DIR, PENDING_DIR);
    await chmod(copies, 0o500);
    try {
      await expect(removeTrick({ configDir: s.configDir, stateDir: s.stateDir, id: "legs", busy: idle })).rejects.toThrow();
    } finally {
      await chmod(copies, 0o700);
    }
    await untouched(s);
    for (const parent of [join(s.configDir, TRICKS_DIR), tricksStateDir(s.stateDir), join(s.configDir, TRICKS_DIR, APPROVED_DIR)]) {
      expect((await readdir(parent)).filter((n) => n.startsWith(GONE_PREFIX))).toEqual([]);
    }
  });
});

describe.if(posix)("a failure before the commit puts everything back", () => {
  test("a commit that cannot be written puts all four places back and nothing is removed", async () => {
    const s = await setup();
    // A file where the commit folder must be: the commit's mkdir fails after all four renames.
    await mkdir(tricksStateDir(s.stateDir), { recursive: true });
    await writeFile(join(tricksStateDir(s.stateDir), ASIDE_COMMITS_DIR), "in the way\n");
    await expect(removeTrick({ configDir: s.configDir, stateDir: s.stateDir, id: "legs", busy: idle })).rejects.toThrow();
    await untouched(s);
    expect((await asides(s)).filter((p) => !p.endsWith(ASIDE_COMMITS_DIR))).toEqual([]);
  });

  test("the trick's own folder is renamed last: a failure of its rename puts the three others back", async () => {
    const s = await setup();
    await chmod(join(s.configDir, TRICKS_DIR), 0o500);
    try {
      await expect(removeTrick({ configDir: s.configDir, stateDir: s.stateDir, id: "legs", busy: idle })).rejects.toThrow();
    } finally {
      await chmod(join(s.configDir, TRICKS_DIR), 0o700);
    }
    await untouched(s);
    expect(await asides(s)).toEqual([]);
  });

  test("a put-back that fails is named with both paths in the error and in the log, never swallowed", async () => {
    const s = await setup();
    const warned: string[] = [];
    const commit = async (): Promise<void> => {
      // Something takes the state folder's name while it is aside, then the commit fails.
      await mkdir(join(s.state, "squatter"), { recursive: true });
      throw new Error("commit failed");
    };
    const out = removeTrick({ configDir: s.configDir, stateDir: s.stateDir, id: "legs", busy: idle, commit, warn: (l) => void warned.push(l) });
    await expect(out).rejects.toThrow(/commit failed; .*\.gone-legs-[0-9a-f]{12} could not be put back at .*legs/u);
    expect(warned.some((l) => l.includes("could not be put back at") && l.includes(s.state))).toBe(true);
    // The others went back; the state aside stays uncommitted, and the sweep leaves it alone: its name is taken.
    for (const path of [s.folder, s.approved, s.pending]) expect(await exists(path)).toBe(true);
    const left = (await asides(s)).filter((p) => p.includes(`${GONE_PREFIX}legs-`));
    expect(left).toHaveLength(1);
    const swept: string[] = [];
    expect(await sweepGone({ stateDir: s.stateDir, configDir: s.configDir, warn: (l) => void swept.push(l) })).toEqual({ removed: 0, restored: 0, kept: 1 });
    expect(await exists(left[0]!)).toBe(true);
    expect(swept.join("\n")).toContain("is there again, so it is left as it is");
  });
});

describe.if(posix)("the switch file must read as switches", () => {
  for (const [label, write] of [
    ["empty", async (path: string) => await writeFile(path, "")],
    ["not JSON", async (path: string) => await writeFile(path, "{ not json")],
    ["a folder in its place", async (path: string) => await mkdir(path, { recursive: true })],
  ] as const) {
    test(`a switch file that is ${label} refuses the remove, moves nothing and is not rewritten`, async () => {
      const s = await setup();
      const path = switchesPath(s.stateDir);
      await rm(path, { force: true });
      await write(path);
      const before = (await lstat(path)).isDirectory() ? null : await readFile(path, "utf8");
      await expect(removeTrick({ configDir: s.configDir, stateDir: s.stateDir, id: "legs", busy: idle })).rejects.toBeInstanceOf(RemoveUnreadable);
      await untouched(s);
      if (before !== null) expect(await readFile(path, "utf8")).toBe(before);
      expect(await asides(s)).toEqual([]);
    });
  }

  test("a missing switch file is no trick on: the remove goes", async () => {
    const s = await setup();
    await rm(switchesPath(s.stateDir));
    expect((await removeTrick({ configDir: s.configDir, stateDir: s.stateDir, id: "legs", busy: idle })).ok).toBe(true);
    expect(await exists(switchesPath(s.stateDir))).toBe(false);
  });
});

describe.if(posix)("a crash, and the sweep at the next start", () => {
  test("after the commit: only dotted names; no scan reads one, a new add of the id keeps its folder, and the sweep deletes them", async () => {
    const s = await setup();
    // What a crash right after the commit leaves: the four places under `.gone-legs-<token>`, and the commit file.
    const token = newAsideToken();
    for (const path of [s.state, s.approved, s.pending, s.folder]) expect(await moveAside(path, "legs", token)).not.toBeNull();
    await commitAside(s.stateDir, "legs", token);
    const scan = await createTrickScanner(join(s.configDir, TRICKS_DIR)).scan();
    expect(scan.tricks.map((t) => t.id)).toEqual(["other"]);
    await mkdir(s.folder, { recursive: true });
    await writeFile(join(s.folder, "new.txt"), "new\n");
    await forgetLeftovers({ stateDir: s.stateDir, configDir: s.configDir, id: "legs", at: "2026-11-21T09:00:00Z" });
    expect(await readFile(join(s.folder, "new.txt"), "utf8")).toBe("new\n");
    expect(await sweepGone({ stateDir: s.stateDir, configDir: s.configDir })).toEqual({ removed: 4, restored: 0, kept: 0 });
    expect(await readFile(join(s.folder, "new.txt"), "utf8")).toBe("new\n");
    expect(await asides(s)).toEqual([]);
    expect(await exists(s.other)).toBe(true);
  });

  test("between the renames (no commit): the sweep puts each place back, and the trick is as it was", async () => {
    const s = await setup();
    // The folder goes last, so a crash before the commit left it in place with the other three aside.
    const token = newAsideToken();
    for (const path of [s.state, s.approved, s.pending]) expect(await moveAside(path, "legs", token)).not.toBeNull();
    expect(await sweepGone({ stateDir: s.stateDir, configDir: s.configDir })).toEqual({ removed: 0, restored: 3, kept: 0 });
    await untouched(s);
    expect(await asides(s)).toEqual([]);
  });
});

describe.if(posix)("B4: the other writers and a remove", () => {
  for (const when of ["during the copy", "after the copy, before the switch write"] as const) {
    test(`a switch on with a remove ${when} writes no entry for the gone folder`, async () => {
      const s = await setup();
      await writeFile(join(s.folder, "trick.toml"), 'id = "legs"\nname = "Legs"\nplaces = ["belt"]\n');
      const removed: Awaited<ReturnType<typeof removeTrick>>[] = [];
      // The remove runs in the middle of the switch on, as a phone and a terminal could.
      const at = (path: string): boolean => (when === "during the copy" ? path.startsWith(`${s.folder}/`) : path.startsWith(`${s.approved}/`) && !path.includes(".stage-"));
      const fs: TrickFs = {
        ...diskTrickFs,
        read: async (path, max) => {
          const bytes = await diskTrickFs.read(path, max);
          if (removed.length === 0 && at(path)) removed.push(await removeTrick({ configDir: s.configDir, stateDir: s.stateDir, id: "legs", busy: idle }));
          return bytes;
        },
      };
      const out = await approveFolder({ stateDir: s.stateDir, configDir: s.configDir, id: "legs", by: "phone", at: "2026-11-21T09:00:00Z", fs });
      expect(removed.map((one) => one.ok)).toEqual([true]);
      expect(out.ok).toBe(false);
      if (when !== "during the copy") expect(out).toEqual({ ok: false, reason: FOLDER_GONE_LINE });
      expect(parseSwitches(await readFile(switchesPath(s.stateDir), "utf8")).switches.on.has("legs")).toBe(false);
      expect(await exists(s.folder)).toBe(false);
    });
  }

  test("updateSwitchesFor writes nothing for a folder that is not there", async () => {
    const s = await setup();
    const before = await readFile(switchesPath(s.stateDir), "utf8");
    expect(await updateSwitchesFor(s.stateDir, join(s.configDir, TRICKS_DIR, "gone"), (now) => withSwitch(now, "gone", true, "2026-11-21T09:00:00Z"))).toBeNull();
    expect(await readFile(switchesPath(s.stateDir), "utf8")).toBe(before);
    expect(await updateSwitchesFor(s.stateDir, s.folder, (now) => withSwitch(now, "legs", true, "2026-11-21T09:00:00Z"))).not.toBeNull();
  });

  test("a new version's write never makes the trick folder again after a remove renamed it", async () => {
    const s = await setup();
    expect((await removeTrick({ configDir: s.configDir, stateDir: s.stateDir, id: "legs", busy: idle })).ok).toBe(true);
    // replaceCode makes the folders of a file one level at a time under the trick folder, never the folder itself.
    await expect(makeFoldersUnder(s.folder, "src/deep")).rejects.toThrow();
    expect(await exists(s.folder)).toBe(false);
    await makeFoldersUnder(s.other, "src/deep");
    expect(await exists(join(s.other, "src", "deep"))).toBe(true);
  });

  test("a batch committed after the sweep's first listing keeps its commit file and its asides", async () => {
    const s = await setup();
    const token = newAsideToken();
    let path = "";
    const out = await sweepGone({
      stateDir: s.stateDir,
      configDir: s.configDir,
      // Another process (a terminal remove) renames and commits its batch right after the listing.
      listed: async () => {
        path = (await moveAside(s.state, "legs", token)) ?? "";
        await commitAside(s.stateDir, "legs", token);
      },
    });
    expect(out).toEqual({ removed: 0, restored: 0, kept: 0 });
    expect(await exists(path)).toBe(true);
    expect(await exists(asideCommitPath(s.stateDir, "legs", token))).toBe(true);
    // The next sweep finishes that batch: the aside and its commit file go.
    expect(await sweepGone({ stateDir: s.stateDir, configDir: s.configDir })).toEqual({ removed: 1, restored: 0, kept: 0 });
    expect(await exists(path)).toBe(false);
    expect(await exists(asideCommitPath(s.stateDir, "legs", token))).toBe(false);
  });

  test("the sweep's put-back waits for the switch file's lock, as an add and a remove do", async () => {
    const s = await setup();
    const token = newAsideToken();
    expect(await moveAside(s.state, "legs", token)).not.toBeNull();
    let swept = false;
    const { withSwitchLock } = await import("./switches.ts");
    let sweep: Promise<unknown> = Promise.resolve();
    await withSwitchLock(s.stateDir, async () => {
      sweep = sweepGone({ stateDir: s.stateDir, configDir: s.configDir }).then(() => (swept = true));
      await Bun.sleep(150);
      expect(swept).toBe(false);
      expect(await exists(s.state)).toBe(false);
    });
    await sweep;
    expect(await exists(s.state)).toBe(true);
  });
});

describe.if(posix)("the run marks the terminal reads", () => {
  test("a mark with a live pid is a run going; unmarked, it is not", async () => {
    const s = await setup();
    const now = Date.now();
    expect(runMarked(s.stateDir, "legs", now)).toBe(false);
    markRun(s.stateDir, "legs", now);
    expect(runMarked(s.stateDir, "legs", now)).toBe(true);
    expect(runMarked(s.stateDir, "other", now)).toBe(false);
    unmarkRun(s.stateDir, "legs");
    expect(runMarked(s.stateDir, "legs", now)).toBe(false);
  });

  test("a mark of a dead pid, or older than the limit, is stale; a mark that does not read is young or stale by its file's age", async () => {
    const s = await setup();
    const now = Date.now();
    await mkdir(join(tricksStateDir(s.stateDir), ".runs"), { recursive: true });
    // Pid 2^22 + 1 is past the Linux default pid_max range used by a test box: not a live process.
    await writeFile(runMarkPath(s.stateDir, "legs"), `4194305 ${String(now)}\n`);
    expect(runMarked(s.stateDir, "legs", now)).toBe(false);
    await writeFile(runMarkPath(s.stateDir, "legs"), `${String(process.pid)} ${String(now - RUN_MARK_MAX_MS - 1)}\n`);
    expect(runMarked(s.stateDir, "legs", now)).toBe(false);
    await writeFile(runMarkPath(s.stateDir, "legs"), "torn");
    expect(runMarked(s.stateDir, "legs", Date.now())).toBe(true);
    expect(runMarked(s.stateDir, "legs", Date.now() + RUN_MARK_MAX_MS + 1000)).toBe(false);
    clearRunMarks(s.stateDir);
    expect(await exists(join(tricksStateDir(s.stateDir), ".runs"))).toBe(false);
  });

  test("a mark is read by its id only: a path never reaches the file name", () => {
    expect(runMarked("/nowhere", "../legs")).toBe(false);
    markRun("/nowhere", "../legs");
    unmarkRun("/nowhere", "../legs");
  });
});
