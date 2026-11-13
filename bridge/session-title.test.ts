import { describe, expect, test } from "bun:test";

import { normalizeTitle, TITLE_MAX } from "./session-title.ts";

// The one normalizer every session name passes through (session-title.ts): journal names, a screen
// read, and every multiplexer's terminal title.

describe("normalizeTitle", () => {
  const cases: ReadonlyArray<[string, string | null | undefined, string | undefined]> = [
    ["a plain name stays", "migrate bluefin", "migrate bluefin"],
    ["the ends are trimmed", "  dialog pings  ", "dialog pings"],
    ["a leading spinner glyph goes", "◐ Reviewing the diff", "Reviewing the diff"],
    ["Claude's settled mark goes", "✳ Fact check ritual", "Fact check ritual"],
    ["a title that opens with punctuation keeps it", "(main) vim", "(main) vim"],
    ["runs of blanks become one space", "fix   the\tlogin", "fix the login"],
    ["a newline becomes a space", "line one\nline two", "line one line two"],
    ["control bytes become a space", "a\u0007b\u001bc", "a b c"],
    ["bidi overrides are dropped", "‮evil‬ name", "evil name"],
    ["a bare glyph names nothing", "◐", undefined],
    ["glyphs and blanks name nothing", "✳ ◐ ", undefined],
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

  test(`caps a long name at ${String(TITLE_MAX)} code points, and never splits a surrogate pair`, () => {
    const long = `${"😀".repeat(TITLE_MAX)}tail`;
    const out = normalizeTitle(`title ${long}`)!;
    expect(Array.from(out).length).toBe(TITLE_MAX);
    expect(out.startsWith("title ")).toBe(true);
    expect(out.endsWith("😀")).toBe(true);
  });
});
