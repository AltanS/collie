import { describe, expect, test } from "bun:test";

import { decodeCursor, encodeCursor, NO_CURSOR } from "./cursor.ts";

// The codec is the one place a cursor can be wrong on purpose. Each test here is one of the three
// fields refusing its own kind of wrong, because every refusal costs a reset and a reset that fires
// for the wrong reason shows the operator less of their session than they had.

const KEY = "/home/someone/.claude/projects/a/b.jsonl";

describe("the cursor codec", () => {
  test("round-trips a position for the key it was taken on", () => {
    expect(decodeCursor(encodeCursor("bytes", KEY, 4096), "bytes", KEY)).toBe(4096);
  });

  test("round-trips zero, which is a real position and not an absent one", () => {
    expect(decodeCursor(encodeCursor("rowid", KEY, 0), "rowid", KEY)).toBe(0);
  });

  test("carries no path, so nothing that logs a cursor logs a home directory", () => {
    const cursor = encodeCursor("bytes", KEY, 12);
    expect(cursor).not.toContain("someone");
    expect(cursor).not.toContain("/");
  });

  test("the empty cursor decodes to nothing, which is what a first read passes", () => {
    expect(decodeCursor(NO_CURSOR, "bytes", KEY)).toBeNull();
  });

  test("refuses a cursor taken on another key — Claude's hand-over, for free", () => {
    const cursor = encodeCursor("bytes", KEY, 900);
    expect(decodeCursor(cursor, "bytes", "/home/someone/.claude/projects/a/c.jsonl")).toBeNull();
  });

  test("refuses a cursor from another counting, so a number is never misread", () => {
    const cursor = encodeCursor("updated", KEY, 900);
    expect(decodeCursor(cursor, "bytes", KEY)).toBeNull();
    expect(decodeCursor(cursor, "rowid", KEY)).toBeNull();
  });

  // Digits only. A negative position is the one that matters: `Bun.file().slice(-5)` reads from the
  // END of the file, so a negative offset would silently read the wrong window rather than fail.
  // Each case here carries the REAL key hash, so the refusal under test is the position field's.
  const HASH = encodeCursor("bytes", KEY, 1).split(":")[2] ?? "";

  test.each([
    ["a negative position", "bytes:-5"],
    ["an empty position", "bytes:"],
    ["exponent notation", "bytes:1e9"],
    ["a float", "bytes:1.5"],
    ["a leading space", "bytes: 1"],
    ["a word", "bytes:many"],
    ["a number past the safe integer range", "bytes:99999999999999999999"],
  ])("refuses %s", (_label, head) => {
    expect(decodeCursor(`${head}:${HASH}`, "bytes", KEY)).toBeNull();
  });

  test.each([
    ["too few fields", "bytes:1"],
    ["too many fields", `bytes:1:${HASH}:more`],
    ["rubbish", "not-a-cursor"],
    ["a bare number", "12"],
  ])("refuses %s", (_label, raw) => {
    expect(decodeCursor(raw, "bytes", KEY)).toBeNull();
  });
});
