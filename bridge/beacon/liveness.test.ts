import { describe, expect, test } from "bun:test";

import { hasStartTimeProbe, parseLstart, parseProcStartTime, procStatPath, PS_LSTART, readStartTimeWith, startTimeProbe } from "./liveness.ts";

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
  test("Linux and macOS read the stat file first; only macOS has a command after it", () => {
    for (const platform of ["linux", "darwin"] as const) {
      expect(startTimeProbe(platform).stat?.path(7)).toBe("/proc/7/stat");
      expect(startTimeProbe(platform).native).toBe(false);
    }
    expect(startTimeProbe("linux").command).toBeNull();
    expect(startTimeProbe("darwin").command).toBe(PS_LSTART);
  });

  test("Windows has the native read alone: no stat file, which anyone may plant under C:\\proc, and no command (#798)", () => {
    expect(startTimeProbe("win32")).toEqual({ stat: null, native: true, command: null });
  });

  test("the macOS command is /bin/ps lstart for one pid, in the C locale and zone UTC", () => {
    expect([PS_LSTART.file, ...PS_LSTART.args(4242)]).toEqual(["/bin/ps", "-o", "lstart=", "-p", "4242"]);
    expect(PS_LSTART.env).toEqual({ LC_ALL: "C", TZ: "UTC0" });
    expect(PS_LSTART.timeoutMs).toBeLessThan(1500);
    expect(PS_LSTART.parse).toBe(parseLstart);
  });

  test("Linux, macOS and Windows have a probe; FreeBSD has none", () => {
    const platforms: NodeJS.Platform[] = ["linux", "darwin", "win32", "freebsd"];
    expect(platforms.map((platform) => hasStartTimeProbe(platform))).toEqual([true, true, true, false]);
  });
});

describe("readStartTimeWith: one order for every caller", () => {
  const STAT = `7 (claude) S ${Array.from({ length: 18 }, (_v, i) => i).join(" ")} 987654 0 0`;
  function seams(over: { stat?: string | null; native?: number | null; ps?: string | null } = {}) {
    const asked: string[] = [];
    return {
      asked,
      seams: {
        readText: (path: string) => (asked.push(`read ${path}`), over.stat === undefined ? STAT : over.stat),
        native: (pid: number) => (asked.push(`native ${String(pid)}`), over.native ?? null),
        run: (command: { file: string }, pid: number) => (asked.push(`run ${command.file} ${String(pid)}`), over.ps ?? null),
      },
    };
  }

  test("Linux: the stat file answers and nothing else is asked", () => {
    const s = seams();
    expect(readStartTimeWith(startTimeProbe("linux"), 7, s.seams)).toBe(987_654);
    expect(s.asked).toEqual(["read /proc/7/stat"]);
  });

  test("macOS: no stat file, so ps runs", () => {
    const s = seams({ stat: null, ps: "Mon Nov  2 10:15:33 2026" });
    expect(readStartTimeWith(startTimeProbe("darwin"), 7, s.seams)).toBe(parseLstart("Mon Nov  2 10:15:33 2026"));
    expect(s.asked).toEqual(["read /proc/7/stat", "run /bin/ps 7"]);
  });

  test("Windows: the native read alone, even with a stat file on disk", () => {
    const s = seams({ native: 1_794_847_739_081_296 });
    expect(readStartTimeWith(startTimeProbe("win32"), 7, s.seams)).toBe(1_794_847_739_081_296);
    expect(s.asked).toEqual(["native 7"]);
    const gone = seams({ native: null });
    expect(readStartTimeWith(startTimeProbe("win32"), 7, gone.seams)).toBeNull();
    expect(gone.asked).toEqual(["native 7"]);
  });

  test("FreeBSD: no stat file and no command is null, and nothing runs", () => {
    const s = seams({ stat: null, native: 5, ps: "Mon Nov  2 10:15:33 2026" });
    expect(readStartTimeWith(startTimeProbe("freebsd"), 7, s.seams)).toBeNull();
    expect(s.asked).toEqual(["read /proc/7/stat"]);
  });
});
