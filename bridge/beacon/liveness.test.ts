import { describe, expect, test } from "bun:test";

import { parseProcStartTime, procStatPath } from "./liveness.ts";

// The pid-reuse guard's unit. The emitter stores what this returns and the reader's liveness seam
// answers with what this returns — a disagreement between the two would make every live beacon read
// expired, which is exactly the kind of failure nobody notices.

/** A stat line with `starttime` (field 22) at a known value. Fields 3..21 are the 19 before it. */
function statLine(comm: string, startTime: number): string {
  const between = Array.from({ length: 19 }, (_v, i) => String(i)).join(" ");
  return `4242 (${comm}) ${between} ${startTime} 140234 0 0 0\n`;
}

describe("parseProcStartTime", () => {
  test("reads field 22", () => {
    expect(parseProcStartTime(statLine("claude", 987_654))).toBe(987_654);
  });

  test("survives a comm field with spaces and brackets — the one an attacker gets to name", () => {
    expect(parseProcStartTime(statLine("my app (2)", 5))).toBe(5);
    expect(parseProcStartTime(statLine(") (", 7))).toBe(7);
  });

  test("is null for anything that is not a stat line", () => {
    for (const junk of ["", "not a stat line", "4242 (claude) S", "4242 claude S 1 2 3"]) {
      expect(parseProcStartTime(junk)).toBeNull();
    }
  });

  test("is null when the field is not a count", () => {
    expect(parseProcStartTime(statLine("claude", Number.NaN))).toBeNull();
  });

  test("names the file the caller's own seam reads", () => {
    expect(procStatPath(4242)).toBe("/proc/4242/stat");
  });
});
