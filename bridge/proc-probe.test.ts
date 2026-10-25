import { describe, expect, test } from "bun:test";

import { DARWIN_BSDINFO_SIZE } from "./beacon/liveness.ts";
import { darwinProbe, linuxProbe, type DarwinCalls } from "./proc-probe.ts";

// The probe is what the writer and the reader share. These tests pin the two behaviours that decide
// whether a live agent reads live or expired: the same pid answers the same start time on both sides,
// and a pid that was REUSED answers a different one.

function bsdInfo(pid: number, ppid: number, sec: number, usec: number, comm: string): Uint8Array {
  const bytes = new Uint8Array(DARWIN_BSDINFO_SIZE);
  const view = new DataView(bytes.buffer);
  view.setUint32(12, pid, true);
  view.setUint32(16, ppid, true);
  bytes.set(new TextEncoder().encode(comm), 48);
  view.setBigUint64(120, BigInt(sec), true);
  view.setBigUint64(128, BigInt(usec), true);
  return bytes;
}

const NOW_MS = 1_792_940_000_000;
const SELF = 900;

/** A fake libproc: one table of processes, mutable so a test can reuse a pid. */
function fakeCalls(table: Map<number, Uint8Array>, args: Map<number, Uint8Array> = new Map()): DarwinCalls {
  return { bsdInfo: (pid) => table.get(pid) ?? null, procArgs: (pid) => args.get(pid) ?? null };
}

describe("darwinProbe", () => {
  const table = (): Map<number, Uint8Array> =>
    new Map([
      [SELF, bsdInfo(SELF, 1, 1_792_939_000, 5, "bun")],
      [4242, bsdInfo(4242, SELF, 1_792_939_500, 250_000, "codex")],
    ]);

  test("answers the start time in microseconds, the unit a beacon stores", () => {
    const probe = darwinProbe(fakeCalls(table()), () => NOW_MS, SELF);
    expect(probe.startTimeOf(4242)).toBe(1_792_939_500_250_000);
    expect(probe.identityOf(4242)).toEqual({ pid: 4242, ppid: SELF, startTime: 1_792_939_500_250_000, comm: "codex" });
  });

  test("a reused pid answers another start time, so the guard sees a different process", () => {
    const processes = table();
    const probe = darwinProbe(fakeCalls(processes), () => NOW_MS, SELF);
    const before = probe.startTimeOf(4242);
    processes.set(4242, bsdInfo(4242, 1, 1_792_939_900, 0, "sleep"));
    expect(probe.startTimeOf(4242)).not.toBe(before);
    expect(probe.startTimeOf(4242)).toBe(1_792_939_900_000_000);
  });

  test("answers null for a process that is gone", () => {
    const probe = darwinProbe(fakeCalls(table()), () => NOW_MS, SELF);
    expect(probe.startTimeOf(31337)).toBeNull();
    expect(probe.identityOf(31337)).toBeNull();
    expect(probe.startTimeOf(0)).toBeNull();
    expect(probe.startTimeOf(-5)).toBeNull();
  });

  test("fails closed when it cannot read its own process: every answer is null", () => {
    const processes = table();
    processes.delete(SELF);
    const probe = darwinProbe(fakeCalls(processes), () => NOW_MS, SELF);
    expect(probe.startTimeOf(4242)).toBeNull();
    expect(probe.argsOf(4242)).toBeNull();
  });

  test("fails closed when its own start time is in the future: that is not this ABI", () => {
    const processes = table();
    processes.set(SELF, bsdInfo(SELF, 1, 1_792_999_999, 0, "bun"));
    const probe = darwinProbe(fakeCalls(processes), () => NOW_MS, SELF);
    expect(probe.startTimeOf(4242)).toBeNull();
  });

  test("a call that throws is a null, not a crash", () => {
    const probe = darwinProbe({ bsdInfo: () => { throw new Error("dlsym"); }, procArgs: () => null }, () => NOW_MS, SELF);
    expect(probe.startTimeOf(4242)).toBeNull();
  });

  test("reads argv through the same trust check", () => {
    const argv = new Uint8Array([2, 0, 0, 0, ...new TextEncoder().encode("/bin/codex\0\0codex\0exec\0HOME=/x\0")]);
    const probe = darwinProbe(fakeCalls(table(), new Map([[4242, argv]])), () => NOW_MS, SELF);
    expect(probe.argsOf(4242)).toEqual(["codex", "exec"]);
  });
});

describe("linuxProbe", () => {
  const files = new Map<string, string>([
    ["/proc/10/stat", "10 (codex) S 4 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 777 0 0"],
    ["/proc/10/cmdline", "codex\0--yolo\0"],
    ["/proc/11/cmdline", ""],
  ]);
  const probe = linuxProbe((path) => files.get(path) ?? null);

  test("reads the start time, the parent and the command line from /proc", () => {
    expect(probe.startTimeOf(10)).toBe(777);
    expect(probe.identityOf(10)).toEqual({ pid: 10, ppid: 4, startTime: 777, comm: "codex" });
    expect(probe.argsOf(10)).toEqual(["codex", "--yolo"]);
  });

  test("a missing or empty entry is null", () => {
    expect(probe.startTimeOf(99)).toBeNull();
    expect(probe.argsOf(11)).toBeNull();
  });
});
