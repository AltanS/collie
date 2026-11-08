import { describe, expect, it } from "vitest";

import { GLYPH_SET_IDS } from "@/lib/glyph-sets";
import { MARK_IDS } from "@/lib/mark-ids";
import { SHIPPED_FONTS } from "@/lib/shipped-fonts";

import { DECORATION_WORD } from "./schema";
import { GROUND_INKS, GROUND_PATTERN_WORDS, GROUND_SIZE_WORDS, GROUND_STRENGTH_WORDS } from "./surface";

// A word this Collie does not know falls back only when it has the shape of a decoration word
// (schema.ts, DECORATION_WORD); any other string is refused. So a word added to a list must have that
// shape too, or an OLDER Collie would refuse the whole file that names it instead of falling back.

const LISTS = {
  "MARK_IDS (character)": MARK_IDS,
  "GLYPH_SET_IDS (glyphs)": GLYPH_SET_IDS,
  "GROUND_PATTERN_WORDS (surface.ground.pattern)": GROUND_PATTERN_WORDS,
  "GROUND_SIZE_WORDS (surface.ground.size)": GROUND_SIZE_WORDS,
  "GROUND_STRENGTH_WORDS (surface.ground.strength)": GROUND_STRENGTH_WORDS,
  "GROUND_INKS (surface.ground.ink)": GROUND_INKS,
  "SHIPPED_FONTS (fonts.ui, fonts.display)": SHIPPED_FONTS,
} as const;

describe("every word on every decoration list", () => {
  for (const [name, words] of Object.entries(LISTS)) {
    it(`${name}: each word has the decoration word shape`, () => {
      expect(words.length).toBeGreaterThan(0);
      expect(words.filter((word) => !DECORATION_WORD.test(word))).toEqual([]);
    });
  }

  it("the shape refuses what no list will ship", () => {
    for (const word of ["", "Upper", "-lead", "a b", "a_b", "x".repeat(33), "https://x"]) expect(DECORATION_WORD.test(word), word).toBe(false);
  });
});
