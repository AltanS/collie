import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

import { agentPidOf } from "../cli/beacon.ts";
import {
  commOfExe,
  filetimeToMicros,
  parseProcessEntry,
  processInfoVia,
  PROCESS_ENTRY_SIZE,
  startTimeVia,
  win32ProcessInfo,
  win32StartTime,
  type ProcessEntry,
  type Win32ProcessApi,
} from "./win32-process.ts";

// Windows' process facts (issue 798). The rules run everywhere through the `Win32ProcessApi` seam; the
// last block calls kernel32 for real and runs only on Windows (windows.yml and the Windows 11 VM).

/** 2026-11-16T16:48:59.0812960Z, the reporter's sample, as a FILETIME (100 ns since 1601). */
const SAMPLE_FILETIME = 134_393_213_390_812_960n;
const SAMPLE_MICROS = Date.UTC(2026, 10, 16, 16, 48, 59) * 1000 + 81_296;

describe("filetimeToMicros", () => {
  test("is whole microseconds since the Unix epoch, exact as a JavaScript integer", () => {
    expect(filetimeToMicros(SAMPLE_FILETIME)).toBe(SAMPLE_MICROS);
    expect(Number.isSafeInteger(filetimeToMicros(SAMPLE_FILETIME))).toBe(true);
    expect(filetimeToMicros(116_444_736_000_000_010n)).toBe(1);
  });

  test("a time at or before 1970, or one past every safe integer, is null", () => {
    expect(filetimeToMicros(0n)).toBeNull();
    expect(filetimeToMicros(116_444_736_000_000_000n)).toBeNull();
    expect(filetimeToMicros(0xffff_ffff_ffff_ffffn * 1000n)).toBeNull();
  });

  test("two processes created 100 ns apart on the same pid read as two start times", () => {
    expect(filetimeToMicros(SAMPLE_FILETIME + 10n)).not.toBe(filetimeToMicros(SAMPLE_FILETIME));
  });
});

/** A `PROCESSENTRY32W` (x64) as kernel32 fills it. */
function entryBytes(pid: number, ppid: number, exe: string): Uint8Array {
  const bytes = new Uint8Array(PROCESS_ENTRY_SIZE);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, PROCESS_ENTRY_SIZE, true);
  view.setUint32(8, pid, true);
  view.setBigUint64(16, 0xdeadn, true);
  view.setUint32(28, 4, true);
  view.setUint32(32, ppid, true);
  for (let i = 0; i < exe.length; i += 1) view.setUint16(44 + i * 2, exe.charCodeAt(i), true);
  return bytes;
}

describe("parseProcessEntry", () => {
  test("reads the pid, the parent and the executable name at their x64 offsets", () => {
    expect(parseProcessEntry(entryBytes(31_337, 4_242, "bash.exe"))).toEqual({ pid: 31_337, ppid: 4_242, exe: "bash.exe" });
  });

  test("a name of all 260 units is read to its end; a short buffer or an empty name is null", () => {
    const long = "a".repeat(260);
    expect(parseProcessEntry(entryBytes(1, 2, long))?.exe).toBe(long);
    expect(parseProcessEntry(new Uint8Array(PROCESS_ENTRY_SIZE - 1))).toBeNull();
    expect(parseProcessEntry(entryBytes(1, 2, ""))).toBeNull();
  });

  test("the x64 size is 568 bytes", () => {
    expect(PROCESS_ENTRY_SIZE).toBe(568);
  });
});

describe("commOfExe", () => {
  test("lower case, without .exe, so Windows shells meet the shell list", () => {
    expect(["bash.exe", "CMD.EXE", "pwsh.exe", "powershell.exe", "claude.exe", "node"].map(commOfExe)).toEqual(["bash", "cmd", "pwsh", "powershell", "claude", "node"]);
  });
});

/** A fake process table: pid to its entry and its creation FILETIME; a pid not in it is gone. */
function fakeApi(rows: Record<number, { ppid: number; exe: string; created: bigint | null }>): Win32ProcessApi {
  return {
    creationTime: (pid) => rows[pid]?.created ?? null,
    snapshot: () => Object.entries(rows).map(([pid, row]): ProcessEntry => ({ pid: Number(pid), ppid: row.ppid, exe: row.exe })),
  };
}

describe("startTimeVia", () => {
  test("a running pid is its creation time in microseconds; a gone pid and a bad pid are null", () => {
    const api = fakeApi({ 4242: { ppid: 1, exe: "claude.exe", created: SAMPLE_FILETIME } });
    expect(startTimeVia(api, 4242)).toBe(SAMPLE_MICROS);
    expect(startTimeVia(api, 4243)).toBeNull();
    expect(startTimeVia(api, 0)).toBeNull();
    expect(startTimeVia(api, -1)).toBeNull();
    expect(startTimeVia(api, 1.5)).toBeNull();
  });
});

describe("processInfoVia: a parent counts only when it started no later than the child", () => {
  const T = SAMPLE_FILETIME;

  test("Git's two bash.exe under claude.exe: each names an older parent, and the climb reaches claude", () => {
    const api = fakeApi({
      100: { ppid: 40, exe: "claude.exe", created: T },
      200: { ppid: 100, exe: "bash.exe", created: T + 10_000n },
      300: { ppid: 200, exe: "bash.exe", created: T + 20_000n },
    });
    expect(processInfoVia(api, 300)).toEqual({ comm: "bash", ppid: 200 });
    expect(processInfoVia(api, 200)).toEqual({ comm: "bash", ppid: 100 });
    expect(agentPidOf(300, (pid) => processInfoVia(api, pid))).toBe(100);
  });

  test("a parent pid now held by a NEWER process (the parent ended, the pid was reused) is not climbed to", () => {
    const api = fakeApi({
      100: { ppid: 40, exe: "editor.exe", created: T + 50_000n },
      300: { ppid: 100, exe: "bash.exe", created: T + 20_000n },
    });
    expect(processInfoVia(api, 300)).toEqual({ comm: "bash", ppid: 0 });
    expect(agentPidOf(300, (pid) => processInfoVia(api, pid))).toBe(300);
  });

  test("a parent that is gone, or a child whose own time is unreadable, ends the climb", () => {
    expect(processInfoVia(fakeApi({ 300: { ppid: 100, exe: "bash.exe", created: T } }), 300)).toEqual({ comm: "bash", ppid: 0 });
    const blind = fakeApi({ 100: { ppid: 40, exe: "claude.exe", created: T }, 300: { ppid: 100, exe: "bash.exe", created: null } });
    expect(processInfoVia(blind, 300)).toEqual({ comm: "bash", ppid: 0 });
  });

  test("a pid that is not in the snapshot, or no snapshot at all, is null", () => {
    expect(processInfoVia(fakeApi({}), 300)).toBeNull();
    expect(processInfoVia({ creationTime: () => T, snapshot: () => null }, 300)).toBeNull();
  });
});

describe("the real reads never throw", () => {
  // No skip on either side: the same test runs on every platform.
  test("off Windows there is no kernel32, so both are null; on Windows both answer for this process", () => {
    const onWindows = process.platform === "win32";
    expect(win32StartTime(process.pid) !== null).toBe(onWindows);
    expect(win32ProcessInfo(process.pid) !== null).toBe(onWindows);
  });
});

// The proof on a real Windows host. `scripts/windows-suites.ps1` runs this file in windows.yml and in
// the VM (`make win-test`).
describe.skipIf(process.platform !== "win32")("kernel32, for real (Windows only, #798)", () => {
  test("this process: a start time just before now, the same on every read", () => {
    const first = win32StartTime(process.pid);
    expect(first).not.toBeNull();
    expect(win32StartTime(process.pid)).toBe(first);
    const startedMs = (first ?? 0) / 1000;
    const expectedMs = Date.now() - process.uptime() * 1000;
    expect(Math.abs(startedMs - expectedMs)).toBeLessThan(60_000);
    expect(startedMs).toBeLessThanOrEqual(Date.now());
  });

  test("this process: its name and its real parent, which started before it", () => {
    const info = win32ProcessInfo(process.pid);
    expect(info).not.toBeNull();
    expect(info?.comm).toMatch(/^bun/u);
    expect(info?.ppid).toBe(process.ppid);
    expect(win32StartTime(process.ppid)).not.toBeNull();
  });

  test("a child that has exited has no start time, so a beacon recorded against it reads expired", () => {
    const child = spawnSync(process.execPath, ["-e", "0"]);
    expect(child.pid).toBeGreaterThan(0);
    expect(win32StartTime(child.pid ?? 0)).toBeNull();
  });

  test("a read is fast enough for a hook: a hundred reads well under the 1.5 s SessionEnd budget", () => {
    const started = performance.now();
    for (let i = 0; i < 100; i += 1) win32StartTime(process.pid);
    win32ProcessInfo(process.pid);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
