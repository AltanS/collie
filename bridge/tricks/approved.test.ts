import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { approveFolder, fileCounts, migrateSwitches, powersOf, promoteCopy, pruneCopies, removeTrickCopies, snapshotTrick, syncConfig, verifyCopy } from "./approved.ts";
import { trickCodeHash } from "./code-hash.ts";
import { createTrickScanner } from "./discover.ts";
import { APPROVED_DIR, approvedCopyDir, approvedTrickDir, hash16, PENDING_DIR, pendingTrickDir, switchesPath, TRICKS_DIR } from "./paths.ts";
import { parseSwitches, withSwitch, type Switches } from "./switches.ts";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-tricks-approved-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const MANIFEST = 'id = "legs"\nname = "Legs"\nrun = "./p.sh"\nplaces = ["belt"]\n';

/** A config dir and a state dir, with one trick folder `legs` holding `files`. */
async function setup(files: Record<string, string> = {}): Promise<{ configDir: string; stateDir: string; dir: string }> {
  const root = await tempDir();
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  const dir = join(configDir, TRICKS_DIR, "legs");
  await mkdir(dir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(dir, "trick.toml"), MANIFEST);
  await writeFile(join(dir, "p.sh"), "#!/bin/sh\necho 1\n", { mode: 0o755 });
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  return { configDir, stateDir, dir };
}

async function hashOf(dir: string): Promise<string> {
  const code = await trickCodeHash(dir);
  if (!code.ok) throw new Error(code.reason);
  return code.hash;
}

describe("a snapshot", () => {
  test("copies the code as the walk hashes it, plus config.toml, the origin record and media/; never node_modules or dot files", async () => {
    const { configDir, dir } = await setup({
      "lib/util.ts": "export const x = 1;\n",
      "config.toml": "rows = 3\n",
      ".collie-origin.json": '{"v":1}\n',
      ".env": "SECRET=1\n",
      "node_modules/pkg/index.js": "module.exports = 1;\n",
      "media/logo.png": "png",
      "run.log": "old\n",
    });
    await symlink("lib/util.ts", join(dir, "link.ts"));
    const snap = await snapshotTrick({ src: dir, parent: approvedTrickDir(configDir, "legs") });
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    expect(snap.hash).toBe(await hashOf(dir));
    expect(snap.dir).toBe(approvedCopyDir(configDir, "legs", snap.hash));
    expect(await hashOf(snap.dir)).toBe(snap.hash);
    expect(await readFile(join(snap.dir, "config.toml"), "utf8")).toBe("rows = 3\n");
    expect(await readFile(join(snap.dir, ".collie-origin.json"), "utf8")).toBe('{"v":1}\n');
    expect(await readFile(join(snap.dir, "media", "logo.png"), "utf8")).toBe("png");
    for (const absent of [".env", "node_modules", "run.log"]) expect(await Bun.file(join(snap.dir, absent)).exists()).toBe(false);
    expect((await readdir(join(snap.dir, "inputs"))).length).toBe(0);
    // A file mode is POSIX; on Windows the copy is not made read only, and the hash check alone guards it.
    if (process.platform !== "win32") {
      expect((await stat(join(snap.dir, "lib", "util.ts"))).mode & 0o777).toBe(0o400);
      expect((await stat(join(snap.dir, "p.sh"))).mode & 0o777).toBe(0o500);
      expect((await stat(join(snap.dir, "config.toml"))).mode & 0o777).toBe(0o600);
    }
    // No stage folder is left behind.
    expect((await readdir(approvedTrickDir(configDir, "legs"))).filter((n) => n.startsWith("."))).toEqual([]);
  });

  test("refuses when the copy does not hash as expected, and leaves nothing", async () => {
    const { configDir, dir } = await setup();
    const snap = await snapshotTrick({ src: dir, parent: approvedTrickDir(configDir, "legs"), expect: "e".repeat(64) });
    expect(snap).toEqual({ ok: false, reason: "The trick folder changed while it was copied." });
    expect(await readdir(approvedTrickDir(configDir, "legs"))).toEqual([]);
  });

  test("keeps a copy already there that hashes right, and replaces one that does not", async () => {
    const { configDir, dir } = await setup();
    const first = await snapshotTrick({ src: dir, parent: approvedTrickDir(configDir, "legs") });
    if (!first.ok) throw new Error(first.reason);
    const again = await snapshotTrick({ src: dir, parent: approvedTrickDir(configDir, "legs") });
    expect(again).toEqual(first);
    await chmod(join(first.dir, "p.sh"), 0o700);
    await writeFile(join(first.dir, "p.sh"), "tampered\n");
    expect(await verifyCopy(first.dir, first.hash)).toEqual({ ok: false, missing: false, reason: "The approved copy changed on disk." });
    const fixed = await snapshotTrick({ src: dir, parent: approvedTrickDir(configDir, "legs") });
    expect(fixed).toEqual(first);
    expect((await verifyCopy(first.dir, first.hash)).ok).toBe(true);
  });

  test("verifyCopy says when there is no copy at all", async () => {
    const { stateDir } = await setup();
    expect(await verifyCopy(join(stateDir, "nope"), "a".repeat(64))).toMatchObject({ ok: false, missing: true });
  });

  test("promoteCopy moves a pending snapshot into the approved place", async () => {
    const { configDir, dir } = await setup();
    const snap = await snapshotTrick({ src: dir, parent: pendingTrickDir(configDir, "legs") });
    if (!snap.ok) throw new Error(snap.reason);
    const target = approvedCopyDir(configDir, "legs", snap.hash);
    expect(await promoteCopy(snap.dir, target, snap.hash)).toBe(true);
    expect(await Bun.file(join(snap.dir, "trick.toml")).exists()).toBe(false);
    expect((await verifyCopy(target, snap.hash)).ok).toBe(true);
  });
});

describe("config.toml and counts", () => {
  test("syncConfig writes a changed config.toml into the copy and removes one the folder dropped", async () => {
    const { configDir, dir } = await setup({ "config.toml": "a = 1\n" });
    const snap = await snapshotTrick({ src: dir, parent: approvedTrickDir(configDir, "legs") });
    if (!snap.ok) throw new Error(snap.reason);
    expect(await syncConfig(dir, snap.dir)).toBe(false);
    await writeFile(join(dir, "config.toml"), "a = 2\n");
    expect(await syncConfig(dir, snap.dir)).toBe(true);
    expect(await readFile(join(snap.dir, "config.toml"), "utf8")).toBe("a = 2\n");
    await rm(join(dir, "config.toml"));
    expect(await syncConfig(dir, snap.dir)).toBe(true);
    expect(await Bun.file(join(snap.dir, "config.toml")).exists()).toBe(false);
    // The code did not move, so the copy still verifies.
    expect((await verifyCopy(snap.dir, snap.hash)).ok).toBe(true);
  });

  test("fileCounts counts code files added, changed and removed", async () => {
    const { configDir, dir } = await setup({ "a.ts": "1\n", "b.ts": "1\n" });
    const one = await snapshotTrick({ src: dir, parent: approvedTrickDir(configDir, "legs") });
    await writeFile(join(dir, "a.ts"), "2\n");
    await rm(join(dir, "b.ts"));
    await writeFile(join(dir, "c.ts"), "1\n");
    await writeFile(join(dir, "config.toml"), "not code\n");
    const two = await snapshotTrick({ src: dir, parent: pendingTrickDir(configDir, "legs") });
    if (!one.ok || !two.ok) throw new Error("snapshot failed");
    expect(await fileCounts(one.dir, two.dir)).toEqual({ added: 1, changed: 1, removed: 1 });
    expect(await fileCounts(null, two.dir)).toEqual({ added: 4, changed: 0, removed: 0 });
  });
});

describe("powers", () => {
  test("a short hash of env and places, blind to order and repeats; inputs is hashed as an empty list today", () => {
    const base = powersOf({ env: ["GH_TOKEN", "A"], places: ["belt", "session"] });
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(powersOf({ env: ["A", "GH_TOKEN", "A"], places: ["session", "belt"] })).toBe(base);
    expect(powersOf({ env: ["A"], places: ["belt", "session"] })).not.toBe(base);
    expect(powersOf({ env: ["GH_TOKEN", "A"], places: ["belt"] })).not.toBe(base);
    expect(powersOf({ places: ["belt"] })).toBe(powersOf({ env: [], places: ["belt"] }));
    // Pinned: a manifest with no `inputs` key keeps this value when the key arrives in a later slice.
    expect(powersOf({ places: ["belt"] })).toBe(new Bun.CryptoHasher("sha256").update('{"env":[],"inputs":[],"places":["belt"]}').digest("hex").slice(0, 16));
    // M99 slice 6: a trick with no inputs keeps the hash it had; a declared glob moves it, in any order once.
    expect(powersOf({ places: ["belt"], inputs: [] })).toBe(powersOf({ places: ["belt"] }));
    const read = powersOf({ places: ["belt"], inputs: ["TODO.md", "notes/*.md"] });
    expect(read).not.toBe(powersOf({ places: ["belt"] }));
    expect(powersOf({ places: ["belt"], inputs: ["notes/*.md", "TODO.md", "TODO.md"] })).toBe(read);
    expect(powersOf({ places: ["belt"], inputs: ["notes/*.md"] })).not.toBe(read);
    expect(read).toBe(new Bun.CryptoHasher("sha256").update('{"env":[],"inputs":["TODO.md","notes/*.md"],"places":["belt"]}').digest("hex").slice(0, 16));
  });
});

describe("approveFolder and migration", () => {
  test("approveFolder copies the folder and writes a version 3 entry with the copy's hash and powers", async () => {
    const { configDir, stateDir, dir } = await setup();
    const out = await approveFolder({ stateDir, configDir, id: "legs", by: "cli", at: "t1" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.hash).toBe(await hashOf(dir));
    const file = parseSwitches(await readFile(switchesPath(stateDir), "utf8")).switches;
    expect(file.version).toBe(3);
    expect(file.on.get("legs")).toEqual({ at: "t1", hash: out.hash, auto: false, by: "cli", powers: powersOf({ places: ["belt"] }) });
  });

  test("the copy lives beside the trick folders, outside the state folder, and the scan never takes it for a trick", async () => {
    const { configDir, stateDir } = await setup();
    const out = await approveFolder({ stateDir, configDir, id: "legs", by: "cli", at: "t1" });
    if (!out.ok) throw new Error(out.reason);
    // The hill refuses a picture inside the state folder (bridge/hill/media.ts), and the copy is where the program runs.
    expect(out.dir.startsWith(join(configDir, TRICKS_DIR, APPROVED_DIR, "legs") + sep)).toBe(true);
    expect(out.dir.startsWith(stateDir)).toBe(false);
    const scan = await createTrickScanner(join(configDir, TRICKS_DIR)).scan();
    expect(scan.tricks.map((t) => t.id)).toEqual(["legs"]);
  });

  test("approveFolder refuses an id that is not a trick id, so no path is built from it", async () => {
    const { configDir, stateDir } = await setup();
    expect(await approveFolder({ stateDir, configDir, id: "../x", by: "cli", at: "t" })).toEqual({ ok: false, reason: "../x is not a trick id." });
  });

  test("a version 2 file: a matching folder is copied and kept, a changed one waits, an id that is not a trick id is left alone", async () => {
    const { configDir, stateDir, dir } = await setup();
    const hash = await hashOf(dir);
    await mkdir(join(stateDir, TRICKS_DIR), { recursive: true });
    await writeFile(switchesPath(stateDir), JSON.stringify({ v: 2, on: { legs: { at: "t1", hash }, gone: { at: "t2", hash: "d".repeat(64) }, "../x": { at: "t3", hash } } }));
    const done = await migrateSwitches({ stateDir, configDir });
    expect(done).toEqual({ kept: ["legs"], waiting: ["gone", "../x"] });
    const file = parseSwitches(await readFile(switchesPath(stateDir), "utf8")).switches;
    expect(file.version).toBe(3);
    expect(file.on.get("legs")).toMatchObject({ hash, by: "migrated" });
    expect(file.on.get("gone")).toMatchObject({ hash: null, by: "migrated" });
    expect((await verifyCopy(approvedCopyDir(configDir, "legs", hash), hash)).ok).toBe(true);
    // Run again: a version 3 file has nothing to migrate.
    expect(await migrateSwitches({ stateDir, configDir })).toBeNull();
  });

  test("no file and a file that does not parse migrate nothing", async () => {
    const { configDir, stateDir } = await setup();
    expect(await migrateSwitches({ stateDir, configDir })).toBeNull();
    await mkdir(join(stateDir, TRICKS_DIR), { recursive: true });
    await writeFile(switchesPath(stateDir), "{ nope");
    expect(await migrateSwitches({ stateDir, configDir })).toBeNull();
    expect(await readFile(switchesPath(stateDir), "utf8")).toBe("{ nope");
  });
});

describe("pruning", () => {
  test("keeps the approved and previous copies of a trick that is on and the pending one named; removes the rest", async () => {
    const { configDir, dir } = await setup();
    const one = await snapshotTrick({ src: dir, parent: approvedTrickDir(configDir, "legs") });
    await writeFile(join(dir, "p.sh"), "#!/bin/sh\necho 2\n");
    const two = await snapshotTrick({ src: dir, parent: approvedTrickDir(configDir, "legs") });
    await writeFile(join(dir, "p.sh"), "#!/bin/sh\necho 3\n");
    const three = await snapshotTrick({ src: dir, parent: approvedTrickDir(configDir, "legs") });
    const waiting = await snapshotTrick({ src: dir, parent: pendingTrickDir(configDir, "legs") });
    const stray = await snapshotTrick({ src: dir, parent: approvedTrickDir(configDir, "other") });
    if (!one.ok || !two.ok || !three.ok || !waiting.ok || !stray.ok) throw new Error("snapshot failed");
    const set: Switches = { on: new Map([["legs", { at: "t", hash: two.hash, auto: false, by: "cli", powers: null, previous: { hash: one.hash, at: "t0", by: "cli", powers: null } }]]) };
    // Too young: nothing goes.
    await pruneCopies(configDir, set, { now: Date.now(), pending: new Map() });
    expect((await readdir(approvedTrickDir(configDir, "legs"))).length).toBe(3);
    await pruneCopies(configDir, set, { now: Date.now(), pending: new Map([["legs", waiting.hash]]), olderThanMs: 0 });
    expect((await readdir(approvedTrickDir(configDir, "legs"))).toSorted()).toEqual([hash16(one.hash), hash16(two.hash)].toSorted());
    expect(await readdir(pendingTrickDir(configDir, "legs"))).toEqual([hash16(waiting.hash)]);
    expect(await Bun.file(approvedTrickDir(configDir, "other")).exists()).toBe(false);
    // Off: every copy goes.
    await pruneCopies(configDir, withSwitch(set, "legs", false, "t"), { now: Date.now(), olderThanMs: 0 });
    expect(await readdir(join(configDir, TRICKS_DIR, APPROVED_DIR))).toEqual([]);
  });

  test("removeTrickCopies takes both folders of one trick", async () => {
    const { configDir, dir } = await setup();
    await snapshotTrick({ src: dir, parent: approvedTrickDir(configDir, "legs") });
    await snapshotTrick({ src: dir, parent: pendingTrickDir(configDir, "legs") });
    await removeTrickCopies(configDir, "legs");
    expect(await Bun.file(join(approvedTrickDir(configDir, "legs"), "x")).exists()).toBe(false);
    expect(await readdir(join(configDir, TRICKS_DIR, APPROVED_DIR))).toEqual([]);
    expect(await readdir(join(configDir, TRICKS_DIR, PENDING_DIR))).toEqual([]);
  });
});
