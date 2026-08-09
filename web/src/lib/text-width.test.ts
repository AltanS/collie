import { describe, expect, it } from "vitest";

import { displayWidth, WIDE_RANGES, COMBINING_RANGES } from "./text-width";

describe("displayWidth", () => {
  it("counts ASCII as one column each", () => {
    expect(displayWidth("abc")).toBe(3);
  });

  it("counts CJK ideographs/kana as two columns each", () => {
    expect(displayWidth("日本語")).toBe(6);
  });

  it("sums mixed ASCII + CJK correctly", () => {
    expect(displayWidth("ab日本")).toBe(2 + 4);
  });

  it("counts a combining mark as zero width (rides on its base)", () => {
    // "e" + COMBINING ACUTE ACCENT (U+0301) — one visual glyph, one base column.
    expect(displayWidth("é")).toBe(1);
  });

  it("pins an Ambiguous-width glyph (→) at 1, not 2", () => {
    // Unicode East Asian Width classifies U+2192 as Ambiguous (A), not Wide — this module treats
    // every A glyph as narrow (module header). Pinned here so a future table edit that widens it
    // is a deliberate, reviewed change.
    expect(displayWidth("→")).toBe(1);
  });
});

describe("displayWidth — East Asian Width boundary pins", () => {
  // Both directions of every boundary, pinned by code point (String.fromCodePoint) rather than by
  // pasting the literal glyph, so the test source stays readable and unambiguous about exactly
  // which code point is under test.
  const w = (cp: number) => displayWidth(String.fromCodePoint(cp));

  it("Hangul Jamo: U+1100 wide, U+115F wide (inside), U+1160 narrow (just past)", () => {
    expect(w(0x1100)).toBe(2);
    expect(w(0x115f)).toBe(2);
    expect(w(0x1160)).toBe(1);
  });

  it("Fullwidth Forms: U+FF00-FF60 wide, U+FF61+ (halfwidth forms) narrow", () => {
    expect(w(0xff00)).toBe(2);
    expect(w(0xff60)).toBe(2);
    expect(w(0xff61)).toBe(1); // HALFWIDTH IDEOGRAPHIC FULL STOP — narrow by design
  });

  it("Fullwidth Signs: U+FFE0-FFE6 wide, just outside narrow", () => {
    expect(w(0xffe0)).toBe(2);
    expect(w(0xffe6)).toBe(2);
    expect(w(0xffdf)).toBe(1);
    expect(w(0xffe7)).toBe(1);
  });

  it("CJK Unified Ideographs Extension B..F (plane 2): U+20000-2FFFD wide", () => {
    expect(w(0x20000)).toBe(2);
    expect(w(0x2fffd)).toBe(2);
    expect(w(0x1ffff)).toBe(1);
    expect(w(0x2fffe)).toBe(1);
  });

  it("CJK Unified Ideographs Extension G (plane 3): U+30000-3FFFD wide", () => {
    expect(w(0x30000)).toBe(2);
    expect(w(0x3fffd)).toBe(2);
  });

  it("EAW=W misc symbols: U+231A-231B and U+2614-2615 wide", () => {
    expect(w(0x231a)).toBe(2); // WATCH
    expect(w(0x231b)).toBe(2); // HOURGLASS
    expect(w(0x2614)).toBe(2); // UMBRELLA WITH RAIN DROPS
    expect(w(0x2615)).toBe(2); // HOT BEVERAGE
    expect(w(0x2319)).toBe(1); // just below 231A — narrow
    expect(w(0x2616)).toBe(1); // just past 2615 — narrow
  });

  it("Vertical Forms U+FE10-FE19 and Small Form Variants U+FE50-FE6B are wide", () => {
    expect(w(0xfe10)).toBe(2);
    expect(w(0xfe19)).toBe(2);
    expect(w(0xfe50)).toBe(2);
    expect(w(0xfe6b)).toBe(2);
  });

  it("Hangul Jamo Extended-A U+A960-A97F is wide", () => {
    expect(w(0xa960)).toBe(2);
    expect(w(0xa97c)).toBe(2);
  });

  it("Kana Supplement / Nushu U+1B000+ is wide", () => {
    expect(w(0x1b000)).toBe(2); // KATAKANA LETTER ARCHAIC E
    expect(w(0x1b2fb)).toBe(2); // NUSHU CHARACTER-1B2FB
  });

  it("emoji sum to their rendered terminal width", () => {
    expect(displayWidth("🎉🎉🎉")).toBe(6);
  });

  it("U+3099/U+309A (combining kana marks) are width 0 despite sitting inside a WIDE range", () => {
    expect(w(0x3099)).toBe(0);
    expect(w(0x309a)).toBe(0);
  });
});

describe("WIDE_RANGES / COMBINING_RANGES — table integrity", () => {
  // `inRanges`'s linear scan bails the moment `cp` is below the current range's floor — correct
  // ONLY if the table is sorted ascending by lower bound. This pin exists so a future range added
  // out of order (easy to do by hand in a 100+ entry table) fails loudly here instead of silently
  // breaking lookups for every range after the misplaced one.
  const assertSortedAndNonOverlapping = (ranges: ReadonlyArray<readonly [number, number]>) => {
    for (let i = 1; i < ranges.length; i++) {
      const [prevLo, prevHi] = ranges[i - 1]!;
      const [lo, hi] = ranges[i]!;
      expect(lo, `range ${i} (0x${lo.toString(16)}) is out of order after 0x${prevLo.toString(16)}`).toBeGreaterThanOrEqual(prevLo);
      expect(hi, `range ${i} (0x${lo.toString(16)}-0x${hi.toString(16)}) is inverted`).toBeGreaterThanOrEqual(lo);
      expect(lo, `range ${i} (0x${lo.toString(16)}) overlaps the previous range ending 0x${prevHi.toString(16)}`).toBeGreaterThan(prevHi);
    }
  };

  it("WIDE_RANGES is sorted ascending and non-overlapping", () => {
    assertSortedAndNonOverlapping(WIDE_RANGES);
  });

  it("COMBINING_RANGES is sorted ascending and non-overlapping", () => {
    assertSortedAndNonOverlapping(COMBINING_RANGES);
  });
});
