import { describe, expect, test } from "bun:test";

import { hasStartTimeProbe, parseLstart, parseProcStartTime, procStatPath, PS_LSTART, startTimeProbe } from "./liveness.ts";

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

// macOS has no `/proc` (M80 spec 11, issue 647): `ps -o lstart= -p <pid>` in the C locale, zone UTC.
describe("parseLstart", () => {
  test("reads a two-digit day as epoch seconds", () => {
    expect(parseLstart("Thu Nov 12 08:00:01 2026")).toBe(Date.UTC(2026, 10, 12, 8, 0, 1) / 1000);
  });

  test("reads a one-digit day padded with two spaces, and the newline ps ends with", () => {
    expect(parseLstart("Mon Nov  2 10:15:33 2026\n")).toBe(Date.UTC(2026, 10, 2, 10, 15, 33) / 1000);
    expect(parseLstart("  Mon Nov  2 10:15:33 2026  ")).toBe(Date.UTC(2026, 10, 2, 10, 15, 33) / 1000);
  });

  test("two reads of one line are one value: it is an identity, unlike etime", () => {
    expect(parseLstart("Sat Feb 28 23:59:59 2026")).toBe(parseLstart("Sat Feb 28 23:59:59 2026"));
  });

  test("is null for an empty line: the pid is gone and ps printed nothing", () => {
    expect(parseLstart("")).toBeNull();
    expect(parseLstart("\n")).toBeNull();
  });

  test("is null for garbage, another locale, and a date that does not exist", () => {
    for (const junk of [
      "garbage",
      "2026-11-02T10:15:33Z",
      "Mon Nov  2 10:15 2026",
      "lun.  2 nov 10:15:33 2026",
      "Mon Foo  2 10:15:33 2026",
      "Mon Feb 30 10:15:33 2026",
      "Mon Nov  2 25:15:33 2026",
      "Mon Nov  2 10:15:33 2026 extra",
      "Mon Nov  2 10:15:33 2026\nTue Nov  3 10:15:33 2026",
    ]) {
      expect(parseLstart(junk)).toBeNull();
    }
  });
});

describe("startTimeProbe", () => {
  test("every host reads the stat file first; only macOS has a command after it", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      expect(startTimeProbe(platform).stat.path(7)).toBe("/proc/7/stat");
    }
    expect(startTimeProbe("linux").command).toBeNull();
    expect(startTimeProbe("win32").command).toBeNull();
    expect(startTimeProbe("darwin").command).toBe(PS_LSTART);
  });

  test("the macOS command is /bin/ps lstart for one pid, in the C locale and zone UTC", () => {
    expect([PS_LSTART.file, ...PS_LSTART.args(4242)]).toEqual(["/bin/ps", "-o", "lstart=", "-p", "4242"]);
    expect(PS_LSTART.env).toEqual({ LC_ALL: "C", TZ: "UTC0" });
    expect(PS_LSTART.timeoutMs).toBeLessThan(1500);
    expect(PS_LSTART.parse).toBe(parseLstart);
  });

  test("only Linux and macOS have a probe", () => {
    const platforms: NodeJS.Platform[] = ["linux", "darwin", "win32", "freebsd"];
    expect(platforms.map((platform) => hasStartTimeProbe(platform))).toEqual([true, true, false, false]);
  });
});
