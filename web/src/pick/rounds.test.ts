import { describe, expect, it } from "vitest";

import { ROUNDS } from "./rounds";
import { MAX_LABEL_WORDS, wordCount } from "./types";

// The round contract (types.ts): the workspace's design app builds every registered round into a
// proposal, so a round that breaks the contract fails here, on its branch, before it is proposed.
describe("every registered round", () => {
  it("has options of at most five words, unique numbers, and a case to open on", async () => {
    for (const [id, load] of ROUNDS) {
      expect(id, id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      const round = (await load()).default;
      expect(round.title.trim(), id).not.toBe("");
      expect(round.cases.length, id).toBeGreaterThan(0);
      expect(round.options.length, id).toBeGreaterThan(0);
      expect(new Set(round.options.map((o) => o.n)).size, id).toBe(round.options.length);
      for (const option of round.options) expect(wordCount(option.label), `${id}: ${option.label}`).toBeLessThanOrEqual(MAX_LABEL_WORDS);
    }
  });

  it("counts words the way the design app does", () => {
    expect(wordCount("  one two  three ")).toBe(3);
  });
});
