import { describe, expect, test } from "bun:test";

import { linuxStartMs, parseBtime, parseEtime, parseProcStat } from "./process-start.ts";

// A real /proc/<pid>/stat line shape: 52 fields, start time (field 22) is 4242.
const statLine = (comm: string) =>
  `1234 (${comm}) S 1 1234 1234 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 5 0 4242 1000000 500 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0`;

describe("parseProcStat", () => {
  test("reads field 22 after the comm", () => {
    expect(parseProcStat(statLine("pi"))).toBe(4242);
  });

  test("a comm with spaces and parentheses does not shift the fields", () => {
    expect(parseProcStat(statLine("my (odd) name"))).toBe(4242);
  });

  test("garbage and short lines answer null", () => {
    expect(parseProcStat("")).toBeNull();
    expect(parseProcStat("no paren here")).toBeNull();
    expect(parseProcStat("1 (x) S 1 2")).toBeNull();
    expect(parseProcStat("1 (x) S " + "a ".repeat(30))).toBeNull();
  });
});

describe("parseBtime", () => {
  test("finds the btime line", () => {
    expect(parseBtime("cpu  1 2 3\nbtime 1761800000\nprocesses 99\n")).toBe(1761800000);
  });

  test("absent or malformed answers null", () => {
    expect(parseBtime("cpu 1 2 3\n")).toBeNull();
    expect(parseBtime("btime abc\n")).toBeNull();
  });
});

describe("linuxStartMs", () => {
  test("boot time plus ticks at 100 per second", () => {
    expect(linuxStartMs(statLine("pi"), "btime 1000\n")).toBe(1000 * 1000 + 42_420);
  });

  test("either text unreadable answers null", () => {
    expect(linuxStartMs("junk", "btime 1000\n")).toBeNull();
    expect(linuxStartMs(statLine("pi"), "junk")).toBeNull();
  });
});

describe("parseEtime", () => {
  test.each([
    ["mm:ss", "05:07", 307_000],
    ["hh:mm:ss", "1:02:03", 3_723_000],
    ["dd-hh:mm:ss", "2-03:04:05", 183_845_000],
    ["padding around it", "  00:09\n", 9000],
  ])("%s", (_name, input, ms) => {
    expect(parseEtime(input)).toBe(ms);
  });

  test("garbage answers null", () => {
    expect(parseEtime("")).toBeNull();
    expect(parseEtime("12")).toBeNull();
    expect(parseEtime("a:b")).toBeNull();
  });
});
