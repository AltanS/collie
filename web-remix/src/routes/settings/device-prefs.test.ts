/// <reference types="bun" />
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

const storage = new MemoryStorage();
let prefs: typeof import("./device-prefs");

beforeAll(async () => {
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  prefs = await import("./device-prefs");
});

describe("flagStore", () => {
  test("a missing key reads the default, and the default is not written", () => {
    const flag = prefs.flagStore("test:default-on", true);
    expect(flag.get()).toBe(true);
    expect(storage.getItem("test:default-on")).toBeNull();
  });

  test("a set writes web's \"1\"/\"0\" form through, once per real change", () => {
    const flag = prefs.flagStore("test:flag", false);
    let wakes = 0;
    flag.subscribe(() => wakes++);
    flag.set(true);
    flag.set(true);
    expect(storage.getItem("test:flag")).toBe("1");
    expect(wakes).toBe(1);
    flag.set(false);
    expect(storage.getItem("test:flag")).toBe("0");
  });

  test("anything but \"1\" reads off; reload re-reads another tab's write", () => {
    const flag = prefs.flagStore("test:other-tab", false);
    storage.setItem("test:other-tab", "1");
    flag.reload();
    expect(flag.get()).toBe(true);
    storage.setItem("test:other-tab", "yes");
    flag.reload();
    expect(flag.get()).toBe(false);
  });
});

describe("the web-compatible keys", () => {
  test("auto-zen and hands-free default off, on web's keys", () => {
    expect(prefs.DEVICE_KEYS.autoZen).toBe("collie:auto-zen-enabled:v1");
    expect(prefs.DEVICE_KEYS.handsFree).toBe("collie:stt-hands-free:v1");
    expect(prefs.autoZen.get()).toBe(false);
    expect(prefs.handsFree.get()).toBe(false);
  });

  test("resetTour writes \"0\" and never removes the key", () => {
    storage.setItem(prefs.DEVICE_KEYS.tour, "2");
    prefs.resetTour();
    expect(storage.getItem(prefs.DEVICE_KEYS.tour)).toBe("0");
  });
});
