/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import { parseAnsi, type AnsiSegment } from "@web/lib/ansi";
import { splitLines } from "@web/lib/blocks";

import { cellStyle, lineSig, reusedRows, rowKeys, toRows } from "./rows";

function seg(over: Partial<AnsiSegment>): AnsiSegment {
  return { text: "x", style: {}, muted: false, ...over };
}

describe("cellStyle", () => {
  test("copies the parser's declarations", () => {
    const [first] = parseAnsi("\u001b[1;31mred\u001b[0m");
    const style = cellStyle(first!);
    expect(style.color).toBe(first!.style.color);
    expect(style.fontWeight).toBe(first!.style.fontWeight);
  });

  test("a plain segment has no declarations", () => {
    expect(cellStyle(seg({}))).toEqual({});
  });

  test("a muted segment takes the muted ink and drops the dim", () => {
    const style = cellStyle(seg({ muted: true, style: { color: "red", opacity: 0.5, fontWeight: 700 } }));
    expect(style).toEqual({ color: "var(--terminal-muted-fg, #a1a1a1)", fontWeight: 400, opacity: 1 });
  });

  test("mobileTransparentBg moves the fill into the custom property", () => {
    const style = cellStyle(seg({ mobileTransparentBg: true, style: { backgroundColor: "#eee" } }));
    expect(style.backgroundColor).toBeUndefined();
    expect(style["--terminal-seg-bg"]).toBe("#eee");
  });

  test("lightDarkFg routes the colour through the light-theme variable", () => {
    const style = cellStyle(seg({ lightDarkFg: true, fg: "#ffd700", style: { color: "#ffd700" } }));
    expect(style.color).toBe("var(--terminal-light-dark-fg, #ffd700)");
  });
});

describe("row keys", () => {
  test("identical rows get distinct keys by occurrence", () => {
    const keys = rowKeys(["a", "b", "a", "a"]);
    expect(new Set(keys).size).toBe(4);
    expect(keys[0]!.split(".")[0]).toBe(keys[2]!.split(".")[0]);
    expect(keys[2]!.endsWith(".1")).toBe(true);
    expect(keys[3]!.endsWith(".2")).toBe(true);
  });

  test("a key follows content, not index", () => {
    const before = rowKeys(["one", "two", "three"]);
    const after = rowKeys(["two", "three", "four"]);
    expect(after[0]).toBe(before[1]);
    expect(after[1]).toBe(before[2]);
  });

  test("styling is part of the signature", () => {
    const [plain] = splitLines(parseAnsi("same"));
    const [red] = splitLines(parseAnsi("\u001b[31msame\u001b[0m"));
    expect(lineSig(plain!)).not.toBe(lineSig(red!));
  });
});

describe("toRows diff", () => {
  test("a scrolled screen reuses every row still on it", () => {
    const first = toRows(splitLines(parseAnsi("a\nb\nc\nd")));
    const next = toRows(splitLines(parseAnsi("b\nc\nd\ne")), first);
    expect(reusedRows(first, next)).toBe(3);
    expect(next[0]).toBe(first[1]!);
    expect(next[3]!.spans[0]!.text).toBe("e");
  });

  test("a changed row is rebuilt, its neighbours are kept", () => {
    const first = toRows(splitLines(parseAnsi("a\nb\nc")));
    const next = toRows(splitLines(parseAnsi("a\nB\nc")), first);
    expect(next[0]).toBe(first[0]!);
    expect(next[1]).not.toBe(first[1]!);
    expect(next[2]).toBe(first[2]!);
  });

  test("an unchanged screen is entirely reused", () => {
    const lines = splitLines(parseAnsi("\u001b[32mok\u001b[0m\n\n\nend"));
    const first = toRows(lines);
    expect(reusedRows(first, toRows(lines, first))).toBe(first.length);
  });
});
