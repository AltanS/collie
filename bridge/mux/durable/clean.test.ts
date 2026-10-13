import { describe, expect, test } from "bun:test";

import { blockRule, byteLength, CAPS, changedByCleaning, cleanText, isWireId, lineRule } from "./clean.ts";

describe("clean: controls, direction marks and caps (WIRE.md section 6)", () => {
  test("clean removes C0 controls, DEL and C1 controls from a one-line field, newline and tab included", () => {
    expect(cleanText("a\u0000b\u001fc\u007fd\u0080e\u009ff\ng\th", lineRule(64))).toBe("abcdefgh");
  });

  test("clean keeps newline and tab in a multi-line field, and still removes the other controls", () => {
    expect(cleanText("one\ntwo\tthree\u0007\r\u0085", blockRule(64))).toBe("one\ntwo\tthree");
  });

  test("clean removes the direction marks, overrides and isolates", () => {
    const marks = "\u200e\u200f\u061c\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
    expect(cleanText(`ab${marks}cd`, lineRule(64))).toBe("abcd");
    // The neighbours of the ranges are not direction marks.
    expect(cleanText("\u2029\u202f⁥\u206a", lineRule(64))).toBe("\u2029\u202f⁥\u206a");
  });

  test("clean removes the zero-width characters and the tag characters", () => {
    const hidden = "\u200b\u200c\u200d\u2060\ufeff";
    expect(cleanText(`ru${hidden}n`, lineRule(64))).toBe("run");
    // A whole sentence in tag characters reads as nothing.
    const tags = [..."rm -rf"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
    expect(cleanText(`ok${String.fromCodePoint(0xe0001)}${tags}${String.fromCodePoint(0xe007f)}`, blockRule(64))).toBe("ok");
    // The neighbours of the ranges stay.
    expect(cleanText("\u200a\u200e\u2061\ufefe\u{e0080}\u{dffff}", lineRule(64))).toBe("\u200a\u2061\ufefe\u{e0080}\u{dffff}");
  });

  test("changedByCleaning says whether a string was cut or lost a character", () => {
    expect(changedByCleaning("plain", lineRule(64))).toBe(false);
    expect(changedByCleaning("a\u200bb", lineRule(64))).toBe(true);
    expect(changedByCleaning("x".repeat(100), lineRule(10))).toBe(true);
  });

  test("clean replaces a lone surrogate, which is not text, with U+FFFD", () => {
    expect(cleanText("a\ud800b", lineRule(64))).toBe("a�b");
  });

  test("clean leaves a string inside the cap exactly as it was", () => {
    expect(cleanText("exactly eight", lineRule(13))).toBe("exactly eight");
  });

  test("clean cuts at the cap with an ellipsis, and the result is never over the cap", () => {
    const cut = cleanText("x".repeat(100), lineRule(10));
    expect(cut).toBe(`${"x".repeat(7)}…`);
    expect(byteLength(cut)).toBe(10);
  });

  test("clean cuts at a whole code point, never inside one", () => {
    // Each 4-byte emoji. A cap of 11 leaves room for 8 bytes of text plus the 3-byte ellipsis.
    const cut = cleanText("\u{1f600}".repeat(5), lineRule(11));
    expect(cut).toBe(`${"\u{1f600}".repeat(2)}…`);
    expect(byteLength(cut)).toBe(11);
    // A 3-byte character that does not fit is left out whole.
    const wide = cleanText("あ".repeat(10), lineRule(10));
    expect(wide).toBe(`${"あ".repeat(2)}…`);
    expect(byteLength(wide)).toBeLessThanOrEqual(10);
  });

  test("clean counts bytes, not characters, against the cap", () => {
    const text = "é".repeat(200);
    expect(byteLength(text)).toBe(400);
    expect(byteLength(cleanText(text, lineRule(CAPS.title)))).toBeLessThanOrEqual(CAPS.title);
  });

  test("clean strips controls before it counts, so they cannot push text past the cap", () => {
    expect(cleanText(`${"\u0000".repeat(500)}ok`, lineRule(8))).toBe("ok");
  });
});

describe("clean: the id rule", () => {
  test("an id is 1 to 128 bytes with no control, whitespace, slash, question mark or hash", () => {
    for (const id of ["a", "conv-01", "ws:tab", "%0", "a".repeat(128)]) expect(isWireId(id)).toBe(true);
    for (const id of ["", "a b", "a/b", "a?b", "a#b", "a\nb", "a\u0000b", "a".repeat(129), "a\u200eb"]) {
      expect(isWireId(id)).toBe(false);
    }
  });

  test("an id is measured in bytes, so 43 three-byte characters are too long", () => {
    expect(isWireId("あ".repeat(42))).toBe(true);
    expect(isWireId("あ".repeat(43))).toBe(false);
  });
});
