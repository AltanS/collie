import { describe, expect, test } from "bun:test";

import { DARWIN_BSDINFO_SIZE, parseDarwinBsdInfo, parseDarwinProcArgs, parseProcStartTime, parseProcStat, procStatPath } from "./liveness.ts";

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

// A real `proc_bsdinfo`, captured on macOS 27 / arm64 with `proc_pidinfo(1679, PROC_PIDTBSDINFO, ...)` for a
// running Codex TUI (`ps` agreed: started Sun Oct 25 08:57:20 2026, 1507 its parent).
const CAPTURED =
  "d040400002000000000000008f060000e3050000f501000014000000f501000014000000f50100001400000000000000636f64657800787900736b0000000000636f64657800787900736b0000000000000000000000000000000000000000002c0100008f060000010000000d0000108f06000000000000b0fcdd6a00000000c6b4080000000000";
const captured = (): Uint8Array => Uint8Array.from(Buffer.from(CAPTURED, "hex"));

describe("parseDarwinBsdInfo", () => {
  test("decodes a captured struct: pid, parent, name and the start time in microseconds", () => {
    expect(parseDarwinBsdInfo(captured(), 1679)).toEqual({ pid: 1679, ppid: 1507, startTime: 1_792_933_040_570_566, comm: "codex" });
  });

  test("refuses bytes for another pid — a shifted layout puts a different word where the pid sits", () => {
    expect(parseDarwinBsdInfo(captured(), 1680)).toBeNull();
    const shifted = new Uint8Array(DARWIN_BSDINFO_SIZE);
    shifted.set(captured().subarray(0, DARWIN_BSDINFO_SIZE - 4), 4);
    expect(parseDarwinBsdInfo(shifted, 1679)).toBeNull();
  });

  test("refuses a struct of any other size, so a layout that grew is never half read", () => {
    expect(parseDarwinBsdInfo(captured().subarray(0, 135), 1679)).toBeNull();
    expect(parseDarwinBsdInfo(new Uint8Array(144), 1679)).toBeNull();
  });

  test("refuses a start time that is not an instant: zero, a microsecond field of a second or more", () => {
    const zero = captured();
    new DataView(zero.buffer).setBigUint64(120, 0n, true);
    expect(parseDarwinBsdInfo(zero, 1679)).toBeNull();
    const wide = captured();
    new DataView(wide.buffer).setBigUint64(128, 1_000_000n, true);
    expect(parseDarwinBsdInfo(wide, 1679)).toBeNull();
  });

  test("refuses a name with a control byte in it", () => {
    const bad = captured();
    bad[50] = 0x07;
    expect(parseDarwinBsdInfo(bad, 1679)).toBeNull();
  });
});

describe("parseProcStat", () => {
  test("reads the parent pid and the name beside the start time, from the last bracket", () => {
    expect(parseProcStat(statLine("my app (2)", 900))).toEqual({ ppid: 1, startTime: 900, comm: "my app (2)" });
    expect(parseProcStat("1 (x) S 77 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 31 0")).toEqual({ ppid: 77, startTime: 31, comm: "x" });
  });

  test("is null for a line that is not a stat line", () => {
    expect(parseProcStat("nope")).toBeNull();
  });
});

describe("parseDarwinProcArgs", () => {
  /** `KERN_PROCARGS2` as the kernel lays it out: argc, the path, padding, argv, then the environment. */
  function procArgs(argc: number, argv: readonly string[], env: readonly string[] = ["HOME=/x"]): Uint8Array {
    const head = new Uint8Array(4);
    new DataView(head.buffer).setInt32(0, argc, true);
    const text = new TextEncoder().encode(`/usr/bin/${argv[0] ?? "x"}\0\0\0${argv.join("\0")}\0${env.join("\0")}\0`);
    return Uint8Array.from([...head, ...text]);
  }

  test("reads exactly argc arguments and never the environment", () => {
    expect(parseDarwinProcArgs(procArgs(3, ["codex", "app-server", "--manage"]))).toEqual(["codex", "app-server", "--manage"]);
    expect(parseDarwinProcArgs(procArgs(1, ["codex", "app-server"]))).toEqual(["codex"]);
  });

  test("keeps an empty argument as an argument", () => {
    expect(parseDarwinProcArgs(procArgs(3, ["sh", "", "x"]))).toEqual(["sh", "", "x"]);
  });

  test("is null when the buffer holds fewer arguments than it says", () => {
    expect(parseDarwinProcArgs(procArgs(5, ["codex"], []))).toBeNull();
    expect(parseDarwinProcArgs(new Uint8Array(3))).toBeNull();
  });
});
