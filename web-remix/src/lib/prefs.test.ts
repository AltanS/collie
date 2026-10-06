/// <reference types="bun" />
// The prefs load at module evaluation. Other test files in this process (gestures) import the module
// first, so the first-read test runs in a fresh `bun` process, and the rest re-read through `reload`.
import { beforeAll, describe, expect, test } from "bun:test";

class MemoryStorage implements Storage {
  #items = new Map<string, string>();
  get length(): number {
    return this.#items.size;
  }
  clear(): void {
    this.#items.clear();
  }
  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.#items.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.#items.delete(key);
  }
  setItem(key: string, value: string): void {
    this.#items.set(key, String(value));
  }
}

const store = new MemoryStorage();
// Seeded BEFORE the module loads: the first read must see these, not the defaults.
store.setItem("collie:zen-enabled:v1", "1");
store.setItem("collie:haptics:v1", "0");
store.setItem("collie:display-prefs:v4", JSON.stringify({ wrap: false, fontSize: 40, fontFamily: "menlo" }));
store.setItem("collie:dash-prefs:v1", JSON.stringify({ paneView: "terminal" }));
Object.defineProperty(globalThis, "localStorage", { value: store, configurable: true });

let prefs: typeof import("./prefs");
beforeAll(async () => {
  Object.defineProperty(globalThis, "localStorage", { value: store, configurable: true });
  prefs = await import("./prefs");
  for (const s of [prefs.dashPrefs, prefs.displayPrefs, prefs.designPrefs, prefs.haptics, prefs.zen, prefs.stripsCollapsed, prefs.harnessBar, prefs.pins, prefs.hiddenMachines]) {
    s.reload();
  }
});

/** A fresh process: storage seeded, then the module's first evaluation reads it. */
const FIRST_READ = `
const items = new Map([["collie:zen-enabled:v1", "1"], ["collie:dash-prefs:v1", '{"paneView":"terminal"}']]);
globalThis.localStorage = { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, v), removeItem: (k) => items.delete(k) };
const prefs = await import(${JSON.stringify(`${import.meta.dir}/prefs.ts`)});
console.log(JSON.stringify([prefs.zen.get(), prefs.dashPrefs.get().paneView]));
`;

describe("prefs: the keys web/ uses", () => {
  test("the exact key names", () => {
    expect(prefs.PREF_KEYS).toEqual({
      dash: "collie:dash-prefs:v1",
      display: "collie:display-prefs:v4",
      design: "collie:design:v1",
      haptics: "collie:haptics:v1",
      zen: "collie:zen-enabled:v1",
      stripsCollapsed: "collie:strips-collapsed:v1",
      harnessBar: "collie:harness-bar:v1",
      pins: "collie:pins:v1",
      hiddenMachines: "collie:hidden-machines:v1",
    });
  });

  test("the first evaluation reads storage, before anything renders", () => {
    const run = Bun.spawnSync(["bun", "-e", FIRST_READ], { cwd: import.meta.dir });
    expect(run.stderr.toString()).toBe("");
    expect(run.stdout.toString().trim()).toBe('[true,"terminal"]');
  });

  test("reads every seeded value", () => {
    expect(prefs.zen.get()).toBe(true);
    expect(prefs.haptics.get()).toBe(false);
    expect(prefs.stripsCollapsed.get()).toBe(false);
    expect(prefs.harnessBar.get()).toBe(true);
    expect(prefs.dashPrefs.get().paneView).toBe("terminal");
    const display = prefs.displayPrefs.get();
    expect(display.wrap).toBe(false);
    expect(display.fontSize).toBe(16); // clamped as web/ clamps
    expect(display.fontFamily).toBe("menlo");
  });

  test("flags write \"1\" and \"0\"", () => {
    prefs.zen.set(false);
    expect(store.getItem("collie:zen-enabled:v1")).toBe("0");
    prefs.stripsCollapsed.set(true);
    expect(store.getItem("collie:strips-collapsed:v1")).toBe("1");
  });

  test("dash prefs write through as web/'s JSON object", () => {
    prefs.setDashPref("paneView", "chat");
    const raw = store.getItem("collie:dash-prefs:v1");
    expect(raw).not.toBeNull();
    const doc: unknown = JSON.parse(raw ?? "null");
    expect(doc).toMatchObject({ paneView: "chat" });
  });

  test("display prefs round-trip with every field", () => {
    const next = { ...prefs.displayPrefs.get(), chatFontSize: 18, tapToFocus: false };
    prefs.displayPrefs.set(next);
    expect(prefs.decodeDisplayPrefs(store.getItem("collie:display-prefs:v4"))).toEqual(next);
  });

  test("pins: an array of {row, space, at}, deduplicated on read", () => {
    prefs.pins.set([{ row: "w1:p1", space: "w1", at: 1 }]);
    expect(JSON.parse(store.getItem("collie:pins:v1") ?? "null")).toEqual([{ row: "w1:p1", space: "w1", at: 1 }]);
    const dup = JSON.stringify([
      { row: "a", space: "s", at: 1 },
      { row: "a", space: "s", at: 2 },
      { row: 3, space: "s", at: 1 },
    ]);
    expect(prefs.decodePins(dup)).toEqual([{ row: "a", space: "s", at: 1 }]);
  });

  test("hidden machines: an array of non-empty unique ids", () => {
    prefs.hiddenMachines.set(["minibuch"]);
    expect(store.getItem("collie:hidden-machines:v1")).toBe('["minibuch"]');
    expect(prefs.decodeHiddenMachines('["a","","a",4,"b"]')).toEqual(["a", "b"]);
    expect(prefs.decodeHiddenMachines("not json")).toEqual([]);
  });

  test("an equal set writes nothing and wakes nobody", () => {
    let wakes = 0;
    const stop = prefs.harnessBar.subscribe(() => wakes++);
    store.removeItem("collie:harness-bar:v1");
    prefs.harnessBar.set(true);
    expect(store.getItem("collie:harness-bar:v1")).toBeNull();
    expect(wakes).toBe(0);
    stop();
  });

  test("a storage event from another tab re-reads the key, and clear() re-reads all", () => {
    const listeners: Array<(event: { readonly key: string | null }) => void> = [];
    const source: import("./prefs").StorageEventSource = { addEventListener: (_type, fn) => listeners.push(fn) };
    const fire = (key: string | null): void => listeners.forEach((fn) => fn({ key }));
    prefs.startPrefSync(source);
    let wakes = 0;
    const stop = prefs.zen.subscribe(() => wakes++);
    store.setItem("collie:zen-enabled:v1", "1");
    fire("collie:zen-enabled:v1");
    expect(prefs.zen.get()).toBe(true);
    expect(wakes).toBe(1);
    store.clear();
    fire(null);
    expect(prefs.zen.get()).toBe(false);
    expect(prefs.haptics.get()).toBe(true);
    stop();
  });
});
