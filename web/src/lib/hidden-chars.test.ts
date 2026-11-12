import { describe, expect, it } from "vitest";

import { HIDDEN_CHAR_CASES } from "../test/hidden-char-cases";
import { codePointName, firstHiddenChar, hasHiddenChar, HIDDEN_RANGES, isHiddenChar } from "./hidden-chars";
import { parseJson } from "./json";
import { parseDecisionView } from "./tricks/schema";

describe("hidden characters: the one table (review 7 M1)", () => {
  it.each(HIDDEN_CHAR_CASES)("$name is hidden: $hidden", ({ ch, hidden }) => {
    expect(isHiddenChar(ch)).toBe(hidden);
    expect(hasHiddenChar(`a${ch}b`)).toBe(hidden);
  });

  it("every listed range is hidden at both ends", () => {
    for (const range of HIDDEN_RANGES) {
      expect(isHiddenChar(String.fromCodePoint(range.from))).toBe(true);
      expect(isHiddenChar(String.fromCodePoint(range.to))).toBe(true);
    }
  });

  it("names the first hidden character", () => {
    expect(firstHiddenChar("// note evil()")).toBe(" ");
    expect(codePointName(" ")).toBe("U+2028");
    expect(codePointName("\u{e0100}")).toBe("U+E0100");
    expect(firstHiddenChar("plain")).toBeNull();
  });
});

describe("the phone's diff refuses a hidden character", () => {
  const view = (text: string) => parseDecisionView(parseJson(JSON.stringify([{ kind: "diff", text, attrs: { file: "main.ts" } }])));

  it.each(HIDDEN_CHAR_CASES.filter((c) => c.hidden))("$name in a diff line refuses the view", ({ ch }) => {
    const read = view(`@@ -0,0 +1,1 @@\n+const a = 1;${ch}`);
    expect(read.view).toBeUndefined();
  });

  it("the U+2028 proof: a comment line, U+2028, then code", () => {
    const read = view("@@ -0,0 +1,1 @@\n+// note evil()");
    expect(read.view).toBeUndefined();
    expect(read.refusals.map((r) => r.reason).join(" ")).toContain("U+2028");
  });

  it("a diff of plain code with a tab passes", () => {
    expect(view("@@ -0,0 +1,1 @@\n+\tconst a = '😀';").view).toBeDefined();
  });
});
