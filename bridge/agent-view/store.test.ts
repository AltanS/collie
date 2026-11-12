import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST } from "../host.ts";
import { ensureOwnerOnlyDir, isOwnerOnly, privateRoot } from "../owner-only.ts";
import { AgentViewStore, trickViewsDir, viewEntry, viewFileName, viewKey, VIEWS_FOLDER, VIEWS_KEPT, type ViewEntry } from "./store.ts";
import type { JsonObject } from "../json.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "view-store-"));
  roots.push(dir);
  return dir;
}

const T = "morph";
const OTHER = "notes";
const ONE = "local/%1#aaaa";
const TWO = "local/%2#bbbb";

/** The folder the view files sit in, for a state dir. */
const viewsOf = (dir: string): string => join(trickViewsDir(dir), VIEWS_FOLDER);
const fileOf = (dir: string, trick: string, session: string): string => join(viewsOf(dir), viewFileName(trick, session));

const view = { rev: 2, at: "2026-11-10T10:00:00.000Z", title: "Tests", view: [{ kind: "para" as const, text: "ok" }] };
const entry = (trick: string, session: string, changedAt: number, over: Partial<ViewEntry> = {}): ViewEntry => viewEntry({ trick, session, on: true, shows: 0, changedAt, ...over });

describe("AgentViewStore", () => {
  test("keeps a drawing in the file as an optional field, and reads a file without one", () => {
    const dir = stateDir();
    const store = new AgentViewStore(trickViewsDir(dir), () => 5000);
    const drawing = { at: "2026-11-10T10:00:00.000Z", note: "Checking" };
    expect(store.put(entry(T, ONE, 5000, { drawing }))).toBe(true);
    expect(store.put(entry(T, TWO, 5000))).toBe(true);
    const again = new AgentViewStore(trickViewsDir(dir), () => 9000);
    expect(again.get(T, ONE)?.drawing).toEqual(drawing);
    expect(again.get(T, TWO)).toEqual(entry(T, TWO, 5000));
    // A drawing that does not fit is dropped, the entry kept.
    writeFileSync(fileOf(dir, T, ONE), JSON.stringify({ v: 1, trick: T, session: ONE, on: true, drawing: { at: "yesterday" } }));
    expect(new AgentViewStore(trickViewsDir(dir), () => 9000).get(T, ONE)).toEqual({ trick: T, session: ONE, on: true, shows: 0, changedAt: 0 });
  });

  test("has no revision and no folder until the first write", () => {
    const dir = stateDir();
    const store = new AgentViewStore(trickViewsDir(dir), () => 5000);
    expect(store.rev()).toBeUndefined();
    expect(existsSync(trickViewsDir(dir))).toBe(false);
  });

  test("writes one file per view, 0600 in a 0700 folder, and a new store reads them back", () => {
    const dir = stateDir();
    // Windows: the bridge gives the state dir an owner-only access list at start (M43 spec 04), and what
    // the store writes inherits it. NTFS has no 0600 or 0700, so the check reads that list instead.
    if (process.platform === "win32") ensureOwnerOnlyDir(dir, HOST, { root: privateRoot("state"), repair: true });
    const store = new AgentViewStore(trickViewsDir(dir), () => 5000);
    const held = entry(T, ONE, 5000, { view, shows: 2, mark: "claude\u0000id:conv-1" });
    expect(store.put(held)).toBe(true);
    expect(store.put(entry(OTHER, ONE, 5000))).toBe(true);
    expect(store.rev()).toBe(5001);
    for (const [path, mode] of [[trickViewsDir(dir), 0o700], [viewsOf(dir), 0o700], [fileOf(dir, T, ONE), 0o600]] as const) {
      if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(mode);
      else expect(isOwnerOnly(path, HOST)).toEqual({ state: "private" });
    }
    expect(readdirSync(viewsOf(dir)).toSorted()).toEqual([viewFileName(T, ONE), viewFileName(OTHER, ONE)].toSorted());
    const again = new AgentViewStore(trickViewsDir(dir), () => 9000);
    expect(again.rev()).toBe(9000);
    expect(again.get(T, ONE)).toEqual(held);
    expect(again.get(OTHER, ONE)).toEqual(entry(OTHER, ONE, 5000));
    // Every view read at boot takes the boot revision: the first read after a restart serves them all.
    expect(again.revOf(T, ONE)).toBe(9000);
    expect(again.revOf(OTHER, ONE)).toBe(9000);
  });

  test("the file name is 32 hex characters of the key, never the trick or the session", () => {
    const name = viewFileName(T, ONE);
    expect(name).toMatch(/^[0-9a-f]{32}\.json$/u);
    expect(name).not.toContain("morph");
    expect(viewFileName(T, ONE)).toBe(name);
    expect(viewFileName(OTHER, ONE)).not.toBe(name);
    expect(viewFileName(T, TWO)).not.toBe(name);
    expect(viewKey(T, ONE)).not.toBe(viewKey(`${T}${ONE.slice(0, 1)}`, ONE.slice(1)));
  });

  test("a write to one view leaves the file of another view byte for byte the same", () => {
    const dir = stateDir();
    const store = new AgentViewStore(trickViewsDir(dir), () => 5000);
    store.put(entry(T, ONE, 5000, { view, shows: 2 }));
    store.put(entry(T, TWO, 5000, { view, shows: 2 }));
    store.put(entry(OTHER, ONE, 5000));
    const before = [fileOf(dir, T, TWO), fileOf(dir, OTHER, ONE)].map((path) => readFileSync(path));
    expect(store.put(entry(T, ONE, 6000, { view: { ...view, rev: 3 }, shows: 3 }))).toBe(true);
    store.touch(T, ONE);
    expect(store.drop(T, ONE)).toBe(true);
    const after = [fileOf(dir, T, TWO), fileOf(dir, OTHER, ONE)].map((path) => readFileSync(path));
    expect(after).toEqual(before);
    expect(existsSync(fileOf(dir, T, ONE))).toBe(false);
    expect(readdirSync(viewsOf(dir))).toHaveLength(2);
  });

  test("the revision rises on every write and every drop, even when the clock stands still", () => {
    const store = new AgentViewStore(null, () => 100);
    store.put(entry(T, "a/%1", 1));
    const first = store.rev()!;
    store.put(entry(T, "a/%2", 1));
    expect(store.rev()).toBe(first + 1);
    store.drop(T, "a/%2");
    expect(store.rev()).toBe(first + 2);
    // A drop of a view the store does not hold writes nothing and moves nothing.
    expect(store.drop(T, "a/%9")).toBe(true);
    expect(store.rev()).toBe(first + 2);
  });

  test("each view holds the revision of its own last change; touch moves one view without a write", () => {
    const dir = stateDir();
    const store = new AgentViewStore(trickViewsDir(dir), () => 100);
    store.put(entry(T, ONE, 1));
    store.put(entry(T, TWO, 1));
    const one = store.revOf(T, ONE)!;
    const two = store.revOf(T, TWO)!;
    expect(two).toBeGreaterThan(one);
    const file = readFileSync(fileOf(dir, T, ONE));
    store.touch(T, ONE);
    expect(store.revOf(T, ONE)).toBeGreaterThan(two);
    expect(store.revOf(T, TWO)).toBe(two);
    expect(store.rev()).toBe(store.revOf(T, ONE)!);
    expect(readFileSync(fileOf(dir, T, ONE))).toEqual(file);
    // A view the store does not hold has no revision, and touching it moves nothing.
    const rev = store.rev();
    store.touch(OTHER, ONE);
    expect(store.revOf(OTHER, ONE)).toBeUndefined();
    expect(store.rev()).toBe(rev);
  });

  test("a view is keyed by trick and session together", () => {
    const store = new AgentViewStore(null, () => 100);
    store.put(entry(T, ONE, 1));
    store.put(entry(OTHER, ONE, 2, { on: false }));
    expect(store.get(T, ONE)?.on).toBe(true);
    expect(store.get(OTHER, ONE)?.on).toBe(false);
    expect(store.get(T, TWO)).toBeUndefined();
    expect(store.all().map((held) => [held.trick, held.session])).toEqual([
      [T, ONE],
      [OTHER, ONE],
    ]);
    store.put(entry(T, ONE, 3, { on: false }));
    expect(store.all()).toHaveLength(2);
  });

  test("sets aside a file that does not read, with one warning, and starts without that view", () => {
    const dir = stateDir();
    mkdirSync(viewsOf(dir), { recursive: true });
    const name = viewFileName(T, ONE);
    writeFileSync(join(viewsOf(dir), name), "{ not json");
    const warned: string[] = [];
    const store = new AgentViewStore(trickViewsDir(dir), () => 7, (line) => warned.push(line));
    expect(store.all()).toEqual([]);
    expect(readdirSync(viewsOf(dir))).toEqual([`${name}.bad-7`]);
    expect(warned).toHaveLength(1);
  });

  test("drops a file it cannot read, keeps the others, and drops a view that does not fit", () => {
    const dir = stateDir();
    mkdirSync(viewsOf(dir), { recursive: true });
    const write = (trick: string, session: string, body: JsonObject, name = viewFileName(trick, session)) => writeFileSync(join(viewsOf(dir), name), JSON.stringify({ v: 1, trick, session, ...body }));
    write(T, "a/%1", { on: true });
    write(T, "a/%2", { on: false, view: { rev: 1, at: "x", view: [] } });
    write("Not A Trick", "a/%3", { on: true });
    write(T, "a/%4", {});
    write(T, "a/%5", { on: true }, "f".repeat(32) + ".json");
    const store = new AgentViewStore(trickViewsDir(dir), () => 7, () => undefined);
    expect(store.all().map((held) => [held.session, held.view]).toSorted()).toEqual([
      ["a/%1", undefined],
      ["a/%2", undefined],
    ]);
    // The three that did not read are set aside, not deleted; a file under another view's name is one of them.
    expect(readdirSync(viewsOf(dir)).filter((name) => name.includes(".bad-"))).toHaveLength(3);
  });

  test("leaves a file that is no view file alone", () => {
    const dir = stateDir();
    mkdirSync(viewsOf(dir), { recursive: true });
    writeFileSync(join(viewsOf(dir), "notes.txt"), "mine");
    writeFileSync(join(viewsOf(dir), `${viewFileName(T, ONE)}.tmp`), "half a write");
    const store = new AgentViewStore(trickViewsDir(dir), () => 7, () => undefined);
    expect(store.all()).toEqual([]);
    expect(readdirSync(viewsOf(dir)).toSorted()).toEqual([`${viewFileName(T, ONE)}.tmp`, "notes.txt"]);
  });

  test("a stored view's rev keeps the show count from falling", () => {
    const dir = stateDir();
    mkdirSync(viewsOf(dir), { recursive: true });
    writeFileSync(fileOf(dir, T, "a/%1"), JSON.stringify({ v: 1, trick: T, session: "a/%1", on: true, shows: 0, view }));
    expect(new AgentViewStore(trickViewsDir(dir)).get(T, "a/%1")?.shows).toBe(2);
  });

  test("a failed write changes nothing in memory", () => {
    const dir = stateDir();
    mkdirSync(trickViewsDir(dir), { recursive: true });
    writeFileSync(join(trickViewsDir(dir), VIEWS_FOLDER), "a file where the folder goes");
    const store = new AgentViewStore(trickViewsDir(dir), () => 7, () => undefined);
    expect(store.put(entry(T, "a/%1", 1))).toBe(false);
    expect(store.all()).toEqual([]);
    expect(store.rev()).toBeUndefined();
    expect(readFileSync(join(trickViewsDir(dir), VIEWS_FOLDER), "utf8")).toBe("a file where the folder goes");
  });

  test("drop removes the file, and the view is gone after a restart", () => {
    const dir = stateDir();
    const store = new AgentViewStore(trickViewsDir(dir), () => 5000);
    store.put(entry(T, ONE, 1));
    store.put(entry(T, TWO, 1));
    expect(store.drop(T, ONE)).toBe(true);
    expect(store.get(T, ONE)).toBeUndefined();
    expect(readdirSync(viewsOf(dir))).toEqual([viewFileName(T, TWO)]);
    expect(new AgentViewStore(trickViewsDir(dir), () => 9000).all().map((held) => held.session)).toEqual([TWO]);
  });

  test("never reads the folder of the old single-file build", () => {
    const dir = stateDir();
    mkdirSync(trickViewsDir(dir), { recursive: true });
    writeFileSync(join(trickViewsDir(dir), "state.json"), JSON.stringify({ v: 1, sessions: [{ session: ONE, on: true }] }));
    const store = new AgentViewStore(trickViewsDir(dir), () => 5000);
    expect(store.all()).toEqual([]);
    expect(readFileSync(join(trickViewsDir(dir), "state.json"), "utf8")).toContain(ONE);
  });
});

describe("viewEntry", () => {
  test("a mark and a stale turn ride only with a screen, and an empty sent list is left off", () => {
    const bare = viewEntry({ trick: T, session: ONE, on: true, shows: 0, changedAt: 1, mark: "claude\u0000x", staleTurn: true, sent: [] });
    expect(bare).toEqual({ trick: T, session: ONE, on: true, shows: 0, changedAt: 1 });
    const screen = viewEntry({ trick: T, session: ONE, on: true, shows: 2, changedAt: 1, view, mark: "claude\u0000x", staleTurn: true });
    expect(screen).toMatchObject({ mark: "claude\u0000x", staleTurn: true });
  });
});

describe("the cap", () => {
  test("keeps the newest views by last change, and removes the files of the others", () => {
    const dir = stateDir();
    const store = new AgentViewStore(trickViewsDir(dir), () => 100);
    for (let i = 0; i < VIEWS_KEPT + 2; i += 1) store.put(entry(T, `a/%${String(i)}`, i));
    expect(store.all()).toHaveLength(VIEWS_KEPT);
    expect(store.get(T, "a/%0")).toBeUndefined();
    expect(store.get(T, "a/%1")).toBeUndefined();
    expect(store.all()[0]?.session).toBe("a/%2");
    expect(readdirSync(viewsOf(dir))).toHaveLength(VIEWS_KEPT);
    expect(existsSync(fileOf(dir, T, "a/%0"))).toBe(false);
    expect(existsSync(fileOf(dir, T, `a/%${String(VIEWS_KEPT + 1)}`))).toBe(true);
  });
});
