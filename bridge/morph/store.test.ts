import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { capped, MORPH_SESSIONS_KEPT, MORPH_STATE_FILE, morphDir, MorphStore, type MorphEntry } from "./store.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "morph-store-"));
  roots.push(dir);
  return dir;
}

const view = { rev: 2, at: "2026-11-10T10:00:00.000Z", title: "Tests", view: [{ kind: "para" as const, text: "ok" }] };
const entry = (session: string, changedAt: number, over: Partial<MorphEntry> = {}): MorphEntry => ({ session, on: true, shows: 0, changedAt, ...over });

describe("MorphStore", () => {
  test("keeps a drawing in the file as an optional field, and reads a file without one", () => {
    const dir = stateDir();
    const store = new MorphStore(morphDir(dir), () => 5000);
    const drawing = { at: "2026-11-10T10:00:00.000Z", note: "Checking" };
    expect(store.replace([entry("local/%1#aaaa", 5000, { drawing }), entry("local/%2#bbbb", 5000)])).toBe(true);
    const again = new MorphStore(morphDir(dir), () => 9000);
    expect(again.get("local/%1#aaaa")?.drawing).toEqual(drawing);
    expect(again.get("local/%2#bbbb")).toEqual(entry("local/%2#bbbb", 5000));
    // A drawing that does not fit is dropped, the entry kept.
    writeFileSync(join(morphDir(dir), MORPH_STATE_FILE), JSON.stringify({ v: 1, sessions: [{ session: "local/%1#aaaa", on: true, drawing: { at: "yesterday" } }] }));
    expect(new MorphStore(morphDir(dir), () => 9000).get("local/%1#aaaa")).toEqual({ session: "local/%1#aaaa", on: true, shows: 0, changedAt: 0 });
  });

  test("has no revision and no folder until the first write", () => {
    const dir = stateDir();
    const store = new MorphStore(morphDir(dir), () => 5000);
    expect(store.rev()).toBeUndefined();
    expect(existsSync(morphDir(dir))).toBe(false);
  });

  test("writes the file 0600 in a 0700 folder, and a new store reads it back", () => {
    const dir = stateDir();
    const store = new MorphStore(morphDir(dir), () => 5000);
    expect(store.replace([entry("local/%1#aaaa", 5000, { view, shows: 2 })])).toBe(true);
    expect(store.rev()).toBe(5000);
    expect(statSync(morphDir(dir)).mode & 0o777).toBe(0o700);
    expect(statSync(join(morphDir(dir), MORPH_STATE_FILE)).mode & 0o777).toBe(0o600);
    const again = new MorphStore(morphDir(dir), () => 9000);
    expect(again.rev()).toBe(9000);
    expect(again.get("local/%1#aaaa")).toEqual(entry("local/%1#aaaa", 5000, { view, shows: 2 }));
  });

  test("the revision rises on every write, even when the clock stands still", () => {
    const store = new MorphStore(null, () => 100);
    store.replace([entry("a/%1", 1)]);
    const first = store.rev()!;
    store.replace([]);
    expect(store.rev()).toBe(first + 1);
  });

  test("sets aside a file that does not read and starts empty", () => {
    const dir = stateDir();
    mkdirSync(morphDir(dir), { recursive: true });
    writeFileSync(join(morphDir(dir), MORPH_STATE_FILE), "{ not json");
    const warned: string[] = [];
    const store = new MorphStore(morphDir(dir), () => 7, (line) => warned.push(line));
    expect(store.all()).toEqual([]);
    expect(store.rev()).toBeUndefined();
    expect(readdirSync(morphDir(dir))).toEqual([`${MORPH_STATE_FILE}.bad-7`]);
    expect(warned).toHaveLength(1);
  });

  test("drops an entry it cannot read, keeps the others, and drops a view that does not fit", () => {
    const dir = stateDir();
    mkdirSync(morphDir(dir), { recursive: true });
    const sessions = [{ session: "a/%1", on: true }, { session: 3 }, { session: "a/%2", on: false, view: { rev: 1, at: "x", view: [] } }];
    writeFileSync(join(morphDir(dir), MORPH_STATE_FILE), JSON.stringify({ v: 1, sessions }));
    const store = new MorphStore(morphDir(dir), () => 7);
    expect(store.all().map((held) => [held.session, held.view])).toEqual([
      ["a/%1", undefined],
      ["a/%2", undefined],
    ]);
  });

  test("a stored view's rev keeps the show count from falling", () => {
    const dir = stateDir();
    mkdirSync(morphDir(dir), { recursive: true });
    writeFileSync(join(morphDir(dir), MORPH_STATE_FILE), JSON.stringify({ v: 1, sessions: [{ session: "a/%1", on: true, shows: 0, view }] }));
    expect(new MorphStore(morphDir(dir)).get("a/%1")?.shows).toBe(2);
  });

  test("a failed write changes nothing in memory", () => {
    const dir = stateDir();
    writeFileSync(join(dir, "morph"), "a file where the folder goes");
    const store = new MorphStore(morphDir(dir), () => 7, () => undefined);
    expect(store.replace([entry("a/%1", 1)])).toBe(false);
    expect(store.all()).toEqual([]);
    expect(store.rev()).toBeUndefined();
    expect(readFileSync(join(dir, "morph"), "utf8")).toBe("a file where the folder goes");
  });
});

describe("capped", () => {
  test("keeps the newest entries by last change, in held order", () => {
    const many = Array.from({ length: MORPH_SESSIONS_KEPT + 2 }, (_, i) => entry(`a/%${String(i)}`, i));
    const kept = capped(many);
    expect(kept).toHaveLength(MORPH_SESSIONS_KEPT);
    expect(kept[0]?.session).toBe("a/%2");
  });
});
