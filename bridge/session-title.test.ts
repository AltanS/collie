import { describe, expect, test } from "bun:test";

import { normalizeTerminalTitle, normalizeTitle, TITLE_MAX } from "./session-title.ts";

// The one normalizer every session name passes through (session-title.ts): journal names, a screen
// read, and, with its glyph strip, every multiplexer's terminal title.

const FAMILY = "👨‍👩‍👧";

describe("normalizeTitle", () => {
  const cases: ReadonlyArray<[string, string | null | undefined, string | undefined]> = [
    ["a plain name stays", "migrate lodge", "migrate lodge"],
    ["the ends are trimmed", "  dialog pings  ", "dialog pings"],
    ["a name a person typed keeps its leading emoji", "🚀 launch", "🚀 launch"],
    ["a name a person typed keeps its leading star", "* todo", "* todo"],
    ["a bare emoji is a name", "🚀", "🚀"],
    ["a title that opens with punctuation keeps it", "(main) vim", "(main) vim"],
    ["runs of blanks become one space", "fix   the\tlogin", "fix the login"],
    ["a newline becomes a space", "line one\nline two", "line one line two"],
    ["control bytes become a space", "a\u0007b\u001bc", "a b c"],
    ["bidi overrides are dropped", "‮evil‬ name", "evil name"],
    ["a zero-width space and a word joiner are dropped", "fix​ the⁠ login", "fix the login"],
    ["a byte order mark and a soft hyphen are dropped", "﻿re­name", "rename"],
    ["zero-width characters alone name nothing", "​⁠﻿", undefined],
    ["the Braille blank alone names nothing", "⠀⠀", undefined],
    ["the Hangul filler alone names nothing", "ㅤ", undefined],
    ["a filler between words becomes a space", "fixㅤlogin", "fix login"],
    ["a joiner inside an emoji sequence stays", `${FAMILY} trip`, `${FAMILY} trip`],
    ["a joiner between letters goes", "a‍b", "ab"],
    ["an empty string names nothing", "", undefined],
    ["blanks name nothing", "   ", undefined],
    ["null is not a name", null, undefined],
    ["undefined is not a name", undefined, undefined],
  ];
  for (const [name, raw, want] of cases) {
    test(name, () => {
      expect(normalizeTitle(raw)).toBe(want);
    });
  }

  test(`caps a long name at ${String(TITLE_MAX)} graphemes, and never splits a cluster`, () => {
    const out = normalizeTitle(`title ${FAMILY.repeat(TITLE_MAX)}tail`)!;
    const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(out)].map((s) => s.segment);
    expect(graphemes.length).toBe(TITLE_MAX);
    expect(out.startsWith("title ")).toBe(true);
    expect(graphemes.at(-1)).toBe(FAMILY);
    const flags = normalizeTitle("🇩🇪".repeat(TITLE_MAX + 5))!;
    expect(flags).toBe("🇩🇪".repeat(TITLE_MAX));
  });
});

describe("normalizeTerminalTitle", () => {
  const cases: ReadonlyArray<[string, string | undefined, string | undefined]> = [
    ["a leading spinner glyph goes", "◐ Reviewing the diff", "Reviewing the diff"],
    ["Claude's settled mark goes", "✳ Fact check ritual", "Fact check ritual"],
    ["a bare glyph names nothing", "◐", undefined],
    ["glyphs and blanks name nothing", "✳ ◐ ", undefined],
    ["a title that opens with punctuation keeps it", "(main) vim", "(main) vim"],
    ["it is cleaned as a name is", "◐ fix​ the\u0007login", "fix the login"],
    ["a zero-width title names nothing", "​", undefined],
  ];
  for (const [name, raw, want] of cases) {
    test(name, () => {
      expect(normalizeTerminalTitle(raw)).toBe(want);
    });
  }
});
