import { describe, expect, it } from "vitest";

import { findMatches, splitSegment } from "./find";

describe("findMatches", () => {
  it("returns nothing for an empty query", () => {
    expect(findMatches("hello world", "")).toEqual([]);
  });

  it("finds a single case-insensitive substring match", () => {
    expect(findMatches("Error: boom", "error")).toEqual([{ start: 0, end: 5 }]);
  });

  it("finds every non-overlapping match, left to right", () => {
    // "aa" in "aaaa" → matches at 0 and 2, not the overlapping one at 1.
    expect(findMatches("aaaa", "aa")).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it("matches across the whole visible string incl. newlines between lines", () => {
    const text = "line one\nERROR here\nline three\nerror again";
    expect(findMatches(text, "error")).toEqual([
      { start: 9, end: 14 },
      { start: 31, end: 36 },
    ]);
  });

  it("returns no matches when the needle is absent", () => {
    expect(findMatches("nothing to see", "xyz")).toEqual([]);
  });
});

describe("splitSegment", () => {
  it("returns the whole segment as one plain piece when there are no matches", () => {
    expect(splitSegment("hello", 0, [])).toEqual([{ text: "hello", matchIndex: null }]);
  });

  it("wraps a match fully inside the segment", () => {
    // "err" of "error" — segment "error" at offset 0, match [0,3)
    expect(splitSegment("error", 0, [{ start: 0, end: 3 }])).toEqual([
      { text: "err", matchIndex: 0 },
      { text: "or", matchIndex: null },
    ]);
  });

  it("emits a leading plain piece before a mid-segment match", () => {
    // segment "the error" at 0, match on "error" [4,9)
    expect(splitSegment("the error", 0, [{ start: 4, end: 9 }])).toEqual([
      { text: "the ", matchIndex: null },
      { text: "error", matchIndex: 0 },
    ]);
  });

  it("tags only the overlapping slice when a match straddles the segment boundary", () => {
    // Visible text "errOR" split into two segments "err" [0,3) and "OR" [3,5); match [0,5).
    // Both segments carry match index 0 → one visual highlight across the colour change.
    expect(splitSegment("err", 0, [{ start: 0, end: 5 }])).toEqual([{ text: "err", matchIndex: 0 }]);
    expect(splitSegment("OR", 3, [{ start: 0, end: 5 }])).toEqual([{ text: "OR", matchIndex: 0 }]);
  });

  it("ignores matches that fall entirely outside the segment", () => {
    // segment "world" at offset 6; a match at [0,5) (in an earlier segment) doesn't touch it.
    expect(splitSegment("world", 6, [{ start: 0, end: 5 }])).toEqual([
      { text: "world", matchIndex: null },
    ]);
  });

  it("keeps global match indices across multiple matches in one segment", () => {
    // "a x a" at 0, matches on each "a": [0,1) index 0, [4,5) index 1
    expect(
      splitSegment("a x a", 0, [
        { start: 0, end: 1 },
        { start: 4, end: 5 },
      ]),
    ).toEqual([
      { text: "a", matchIndex: 0 },
      { text: " x ", matchIndex: null },
      { text: "a", matchIndex: 1 },
    ]);
  });
});
