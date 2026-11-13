import { describe, expect, it } from "vitest";

import { ENTRIES } from "./registry";

// The design reference's entry rule (CLAUDE.md, "The design reference"): every entry has an id that is
// its address, no two entries share one, and every entry carries the words a person types to find it.
// An entry with no keywords can be found by its title alone, and the title is rarely the word a
// person remembers ("worktree", "permission", the component's name).
describe("the design reference's entries", () => {
  const defs = ENTRIES.map((entry) => entry.def);

  it("each have a flat kebab-case id", () => {
    expect(defs.filter((def) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(def.id)).map((def) => def.id)).toEqual([]);
  });

  it("never share an id", () => {
    const seen = new Set<string>();
    const repeated = defs.flatMap((def) => {
      const twice = seen.has(def.id);
      seen.add(def.id);
      return twice ? [def.id] : [];
    });
    expect(repeated).toEqual([]);
  });

  it("each have a title, a group and search keywords", () => {
    expect(defs.filter((def) => def.title.trim() === "").map((def) => def.id)).toEqual([]);
    expect(defs.filter((def) => def.group.trim() === "").map((def) => def.id)).toEqual([]);
    expect(defs.filter((def) => def.keywords.length === 0).map((def) => def.id)).toEqual([]);
    expect(defs.filter((def) => def.keywords.some((word) => word.trim() === "" || /\s/.test(word))).map((def) => def.id)).toEqual([]);
  });
});

// The workspace's design app imports this module by path and reads only data and loaders from it.
describe("the registry module", () => {
  it("loads every entry to a component", async () => {
    for (const entry of ENTRIES) {
      const mod = await entry.load();
      expect(mod.default, entry.def.id).toBeInstanceOf(Function);
    }
  }, 60_000);
});
