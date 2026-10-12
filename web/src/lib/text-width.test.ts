import { describe, expect, it } from "vitest";

import { cellsByColumn, displayWidth, widePieces, WIDE_RANGES, COMBINING_RANGES, EMOJI_TEXT_DEFAULT_RANGES } from "./text-width";

describe("widePieces", () => {
  it("cuts each double-width cluster out alone and keeps the narrow runs between them whole", () => {
    expect(widePieces("│ 廚房 │")).toEqual([
      { text: "│ ", wide: false },
      { text: "廚", wide: true },
      { text: "房", wide: true },
      { text: " │", wide: false },
    ]);
  });
});

describe("cellsByColumn", () => {
  it("keys each cluster by the column it starts at, leaving a wide cluster's second column empty", () => {
    expect([...cellsByColumn("│ 廚房 │")]).toEqual([
      [0, "│"],
      [1, " "],
      [2, "廚"],
      [4, "房"],
      [6, " "],
      [7, "│"],
    ]);
  });
});

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

describe("displayWidth — VS16 emoji, as Herdr 0.9.3 draws them", () => {
  // Measured 2026-10-12 with a cursor position report after each sample in a Herdr pane: the cursor
  // advanced two columns for each emoji sequence below and one for each bare base or non-emoji base.
  it("counts a text-default emoji followed by VS16 as two columns", () => {
    expect(displayWidth("\u26a0\ufe0f")).toBe(2); // warning sign
    expect(displayWidth("\u2764\ufe0f")).toBe(2); // red heart
    expect(displayWidth("\u2714\ufe0f")).toBe(2);
    expect(displayWidth("\u2139\ufe0f")).toBe(2);
    expect(displayWidth("\u00a9\ufe0f")).toBe(2);
    expect(displayWidth("\u2764\ufe0f\u200d\u{1f525}")).toBe(2); // heart on fire, one cluster
  });

  it("counts a keycap as two columns", () => {
    expect(displayWidth("1\ufe0f\u20e3")).toBe(2);
  });

  it("keeps the bare base, and a base with no emoji form, at one column", () => {
    expect(displayWidth("\u26a0")).toBe(1);
    expect(displayWidth("\u2764")).toBe(1);
    expect(displayWidth("a\ufe0f")).toBe(1);
    expect(displayWidth("\u00e9\ufe0f")).toBe(1);
    expect(displayWidth("\u2192\ufe0f")).toBe(1);
    expect(displayWidth("\u20ac\ufe0f")).toBe(1);
  });

  it("lays a row out by columns, so the wall after a VS16 emoji stands where the terminal drew it", () => {
    expect([...cellsByColumn("\u2502 \u26a0\ufe0f \u2502")].map(([column]) => column)).toEqual([0, 1, 2, 4, 5]);
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

  it("EMOJI_TEXT_DEFAULT_RANGES is sorted ascending and non-overlapping", () => {
    assertSortedAndNonOverlapping(EMOJI_TEXT_DEFAULT_RANGES);
  });
});
