import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { forgetTourMemory, markTourSeen, readTourSeen, shouldShowTour, TOUR_STORAGE_KEY, TOUR_VERSION } from "./store";

const data = new Map<string, string>();
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

beforeEach(() => {
  data.clear();
  forgetTourMemory();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
});

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("the first-run store", () => {
  test("spells the key and the version as web/src/lib/tour.ts does", () => {
    const source = readFileSync(new URL("../../../web/src/lib/tour.ts", import.meta.url), "utf8");
    expect(source).toContain(`TOUR_STORAGE_KEY = "${TOUR_STORAGE_KEY}"`);
    expect(source).toContain(`TOUR_VERSION = ${String(TOUR_VERSION)};`);
  });

  test("a fresh device has not seen it, so it shows", () => {
    expect(readTourSeen()).toBe(0);
    expect(shouldShowTour(readTourSeen())).toBe(true);
  });

  test("marking seen writes the version as a decimal string and stops showing", () => {
    markTourSeen();
    expect(data.get(TOUR_STORAGE_KEY)).toBe(String(TOUR_VERSION));
    expect(shouldShowTour(readTourSeen())).toBe(false);
  });

  test("a reset written straight to storage is read at once", () => {
    markTourSeen();
    data.set(TOUR_STORAGE_KEY, "0");
    expect(shouldShowTour(readTourSeen())).toBe(true);
  });

  test("an older version shows once more; garbage reads as never seen", () => {
    data.set(TOUR_STORAGE_KEY, "1");
    expect(shouldShowTour(readTourSeen())).toBe(true);
    data.set(TOUR_STORAGE_KEY, "nope");
    expect(readTourSeen()).toBe(0);
  });

  test("storage that refuses the write still counts as seen for the session", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota");
        },
      },
    });
    markTourSeen();
    expect(shouldShowTour(readTourSeen())).toBe(false);
  });
});
