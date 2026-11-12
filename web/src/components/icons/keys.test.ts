import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ICON_KEYS, ICON_KEY_LIST } from "./keys";
import { keysMarkdown } from "./keys-md";
import { LUCIDE } from "./lucide";
import { ICONOIR } from "./sets/iconoir";
import { PHOSPHOR } from "./sets/phosphor";

describe("the icon key table", () => {
  it("names each key's lucide glyph as lucide.ts draws it", () => {
    for (const key of ICON_KEY_LIST) {
      expect(LUCIDE[key].displayName, key).toBe(ICON_KEYS[key].lucide);
    }
  });

  it("keys name a meaning: lower-case words joined by hyphens", () => {
    for (const key of ICON_KEY_LIST) expect(key).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
  });

  it("every key has a meaning in plain words", () => {
    for (const key of ICON_KEY_LIST) expect(ICON_KEYS[key].meaning.length, key).toBeGreaterThan(2);
  });

  it("KEYS.md is current (bun scripts/glyph-keys.ts)", () => {
    const onDisk = readFileSync(resolve(import.meta.dirname, "KEYS.md"), "utf8");
    expect(onDisk).toBe(keysMarkdown());
  });
});

// A key a family does not draw falls back to its lucide glyph. These are the fallbacks, by name, so a
// new one is a decision someone reads here. The brief's bar is under 5 percent per family.
const FALLBACKS = {
  phosphor: ["key-space", "text-larger", "text-smaller"],
  iconoir: ["busy", "hill", "hill-now", "key-space", "text-larger", "text-smaller"],
};

describe("the family maps", () => {
  for (const [family, map] of [
    ["phosphor", PHOSPHOR],
    ["iconoir", ICONOIR],
  ] as const) {
    it(`${family}: the fallbacks are the listed ones, under 5 percent of the keys`, () => {
      const missing = ICON_KEY_LIST.filter((key) => map[key] === null);
      expect(missing).toEqual(FALLBACKS[family]);
      expect(missing.length / ICON_KEY_LIST.length).toBeLessThan(0.05);
    });

    it(`${family}: every mapped name is a file name, lower-case words and hyphens`, () => {
      for (const key of ICON_KEY_LIST) {
        const name = map[key];
        if (name !== null) expect(name, key).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      }
    });
  }
});
