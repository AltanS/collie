import { afterAll, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST } from "../host.ts";
import { forgetLeftovers, GONE_PREFIX, moveAside, sweepGone } from "./approved.ts";
import { createTrickScanner } from "./discover.ts";
import { APPROVED_DIR, PENDING_DIR, switchesPath, TRICKS_DIR, tricksStateDir, trickStateDir } from "./paths.ts";
import { clearRunMarks, markRun, REMOVE_LINK_LINE, REMOVE_ON_LINE, REMOVE_RUNNING_LINE, removeTrick, RUN_MARK_MAX_MS, runMarked, runMarkPath, unmarkRun } from "./remove.ts";
import { parseSwitches, withSwitch, writeSwitches } from "./switches.ts";

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

describe.if(posix)("removeTrick: what goes", () => {
  test("a trick that is off: its folder, its state folder and its copies go; forget runs once; nothing else moves", async () => {
    const s = await setup();
    const forgot: string[] = [];
    const out = await removeTrick({ configDir: s.configDir, stateDir: s.stateDir, id: "legs", busy: idle, forget: (id) => void forgot.push(id) });
    expect(out).toEqual({ ok: true, folder: s.folder, state: s.state });
    for (const path of [s.folder, s.state, s.approved, s.pending]) expect(await exists(path)).toBe(false);
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

  test("a forget that throws still leaves nothing set aside", async () => {
    const s = await setup();
    const out = removeTrick({ configDir: s.configDir, stateDir: s.stateDir, id: "legs", busy: idle, forget: () => { throw new Error("views"); } });
    await expect(out).rejects.toThrow("views");
    expect(await exists(s.folder)).toBe(false);
    expect((await readdir(join(s.configDir, TRICKS_DIR))).filter((n) => n.startsWith(GONE_PREFIX))).toEqual([]);
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

describe.if(posix)("a crash between the rename and the delete", () => {
  test("leaves dotted names only: no scan reads one, a new add of the id is not refused or wiped by it, and the start sweeps it", async () => {
    const s = await setup();
    // What a crash right after the renames leaves: the four places under `.gone-legs-*`.
    for (const path of [s.folder, s.state, s.approved, s.pending]) expect(await moveAside(path, "legs")).not.toBeNull();
    const scan = await createTrickScanner(join(s.configDir, TRICKS_DIR)).scan();
    expect(scan.tricks.map((t) => t.id)).toEqual(["other"]);
    // A new trick of the same id: the leftovers are not its folder, so the add's own check sees no trick there.
    await mkdir(s.folder, { recursive: true });
    await writeFile(join(s.folder, "new.txt"), "new\n");
    await forgetLeftovers({ stateDir: s.stateDir, configDir: s.configDir, id: "legs", at: "2026-11-21T09:00:00Z" });
    expect(await readFile(join(s.folder, "new.txt"), "utf8")).toBe("new\n");
    expect(await sweepGone({ stateDir: s.stateDir, configDir: s.configDir })).toBe(4);
    expect(await readFile(join(s.folder, "new.txt"), "utf8")).toBe("new\n");
    expect(await exists(s.other)).toBe(true);
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
