import { afterAll, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UNSETTLED_LISTING, snapshotTrick, verifyCopy } from "./approved.ts";
import { diskTrickFs, type TrickFs } from "./code-hash.ts";
import { createTrickScanner } from "./discover.ts";
import { TricksFeatureSwitch, tricksFeaturePath } from "./feature-switch.ts";
import { approvedTrickDir, switchesPath, TRICKS_DIR, tricksStateDir } from "./paths.ts";
import { RACY_WINDOW_MS } from "../stat-held.ts";
import { createSwitchReader } from "./switches.ts";
import { TrickValues, valuesPath } from "./values.ts";

// The racy-timestamp rule (bridge/stat-held.ts) for every stat-keyed cache in the tricks code. Each case holds the stat
// still with a fake `stat` (the same size, modified time, inode and change time), rewrites the file with other
// bytes of the same size, and lets only the clock of the read decide: inside the window the new content is read,
// after it the cache answers and the file is not read. No sleep, no reliance on a file system's time resolution.
// The picture caches and the Hill digest have their cases beside their own tests (media.test.ts, hill.test.ts).

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "collie-stat-held-"));
  roots.push(root);
  return root;
}

/** The stat facts every fake answers: a file last written at `AT`. */
const AT = 1_800_000_000_000;
const INSIDE = AT + RACY_WINDOW_MS / 4;
const AFTER = AT + RACY_WINDOW_MS * 5;
const still = (path: string) => ({ size: statSync(path).size, mtimeMs: AT, ino: 7, ctimeMs: AT });

describe("the switch reader", () => {
  const setup = () => {
    const stateDir = tempRoot();
    mkdirSync(tricksStateDir(stateDir), { recursive: true });
    const write = (id: string) => writeFileSync(switchesPath(stateDir), JSON.stringify({ v: 1, layout: 3, on: { [id]: { at: "t", hash: null, auto: false, by: "cli", powers: null } } }));
    const stats: string[] = [];
    return { stateDir, write, stat: async (path: string) => (stats.push(path), still(path)), stats };
  };

  test("a same-size rewrite inside the window of the read is read", async () => {
    const r = setup();
    const read = createSwitchReader(r.stateDir, () => {}, { now: () => INSIDE, stat: r.stat });
    r.write("aaaa");
    expect([...(await read()).on.keys()]).toEqual(["aaaa"]);
    r.write("bbbb");
    expect([...(await read()).on.keys()]).toEqual(["bbbb"]);
  });

  test("after the window the cache answers and the file is not read", async () => {
    const r = setup();
    const read = createSwitchReader(r.stateDir, () => {}, { now: () => AFTER, stat: r.stat });
    r.write("aaaa");
    expect([...(await read()).on.keys()]).toEqual(["aaaa"]);
    r.write("bbbb");
    // The stat is asked, the bytes are not: the held read of "aaaa" stands.
    expect([...(await read()).on.keys()]).toEqual(["aaaa"]);
    expect(r.stats).toHaveLength(2);
  });

  test("a broken file re-read inside the window warns once", async () => {
    const r = setup();
    const warned: string[] = [];
    const read = createSwitchReader(r.stateDir, (line) => warned.push(line), { now: () => INSIDE, stat: r.stat });
    writeFileSync(switchesPath(r.stateDir), "{ torn");
    await read();
    await read();
    expect(warned).toHaveLength(1);
  });
});

describe("a trick's values", () => {
  test("a same-size rewrite inside the window is read; after it the cache answers", () => {
    const stateDir = tempRoot();
    let clock = INSIDE;
    let stats = 0;
    const values = new TrickValues(stateDir, { now: () => clock, stat: (path) => ((stats += 1), still(path)) });
    values.write("legs", { note: "aaaa" });
    expect(values.read("legs").values).toEqual({ note: "aaaa" });
    values.write("legs", { note: "bbbb" });
    expect(values.read("legs").values).toEqual({ note: "bbbb" });
    clock = AFTER;
    expect(values.read("legs").values).toEqual({ note: "bbbb" });
    // Settled: a rewrite with the same stat is not read.
    writeFileSync(valuesPath(stateDir, "legs"), JSON.stringify({ v: 1, values: { note: "cccc" } }).padEnd(statSync(valuesPath(stateDir, "legs")).size));
    expect(values.read("legs").values).toEqual({ note: "bbbb" });
    expect(stats).toBe(4);
  });
});

describe("the tricks switch", () => {
  test("a same-size rewrite inside the window is read; after it the cache answers", () => {
    const stateDir = tempRoot();
    mkdirSync(tricksStateDir(stateDir), { recursive: true });
    let clock = INSIDE;
    const sw = new TricksFeatureSwitch(stateDir, () => {}, Date.now, { clock: () => clock, stat: still });
    // The same length on and off, so only the bytes differ.
    writeFileSync(tricksFeaturePath(stateDir), '{"v":1,"on":true }');
    expect(sw.reading()).toBe("on");
    writeFileSync(tricksFeaturePath(stateDir), '{"v":1,"on":false}');
    expect(sw.reading()).toBe("off");
    clock = AFTER;
    expect(sw.reading()).toBe("off");
    writeFileSync(tricksFeaturePath(stateDir), '{"v":1,"on":true }');
    expect(sw.reading()).toBe("off");
  });
});

describe("a trick folder's scan and its approved copy", () => {
  /** The disk, with every `lstat` held at the same facts, and the manifest reads counted. */
  const heldFs = () => {
    let reads = 0;
    const fs: TrickFs = {
      ...diskTrickFs,
      lstat: async (path) => {
        const st = await diskTrickFs.lstat(path);
        return st === null ? null : { ...st, mtimeMs: AT, ino: 7, ctimeMs: AT };
      },
      read: (path, max) => {
        if (path.endsWith("trick.toml")) reads += 1;
        return diskTrickFs.read(path, max);
      },
    };
    return { fs, reads: () => reads };
  };
  const manifest = (name: string) => `id = "legs"\nname = "${name}"\nrun = "./x"\nplaces = ["belt"]\n`;

  test("a same-size rewrite of the manifest inside the window is parsed again; after it the scan reuses its read", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "legs"));
    writeFileSync(join(root, "legs", "trick.toml"), manifest("aaaa"));
    let clock = INSIDE;
    const { fs, reads } = heldFs();
    const scanner = createTrickScanner(root, { fs, now: () => clock });
    expect((await scanner.scan()).tricks[0]?.manifest?.name).toBe("aaaa");
    writeFileSync(join(root, "legs", "trick.toml"), manifest("bbbb"));
    expect((await scanner.scan()).tricks[0]?.manifest?.name).toBe("bbbb");
    clock = AFTER;
    expect((await scanner.scan()).tricks[0]?.manifest?.name).toBe("bbbb");
    const settled = reads();
    writeFileSync(join(root, "legs", "trick.toml"), manifest("cccc"));
    expect((await scanner.scan()).tricks[0]?.manifest?.name).toBe("bbbb");
    expect(reads()).toBe(settled);
  });

  test("a copy checked inside the window gives no listing to trust; after it the listing is the walk's", async () => {
    const root = tempRoot();
    const configDir = join(root, "config");
    const dir = join(configDir, TRICKS_DIR, "legs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "trick.toml"), manifest("aaaa"));
    const snap = await snapshotTrick({ src: dir, parent: approvedTrickDir(configDir, "legs") });
    if (!snap.ok) throw new Error(snap.reason);
    const { fs } = heldFs();
    expect(await verifyCopy(snap.dir, snap.hash, fs, () => INSIDE)).toEqual({ ok: true, listing: UNSETTLED_LISTING });
    const after = await verifyCopy(snap.dir, snap.hash, fs, () => AFTER);
    expect(after.ok && after.listing).not.toBe(UNSETTLED_LISTING);
    expect(lstatSync(snap.dir).isDirectory()).toBe(true);
  });
});
