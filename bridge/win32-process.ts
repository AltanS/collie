// Windows' process facts, read in process through kernel32 (issue 798).
//
// Linux answers a pid's start time and parent from `/proc/<pid>/stat`, macOS from one `ps` run. Windows
// has neither, and the only shell-level answer, PowerShell's `Get-Process` or `Win32_Process`, costs 3 to
// 5 seconds per run on a quiet machine and up to 30 under load (#762). A Claude hook runs on every event
// with a 1.5 s budget on `SessionEnd`, so that is no probe. kernel32 answers the same question in well
// under a millisecond, with no process started:
//
//  - the START TIME: `OpenProcess` with `PROCESS_QUERY_LIMITED_INFORMATION`, `GetExitCodeProcess` (a
//    process that ended has no start time here, even while a handle keeps its object), and
//    `GetProcessTimes`' creation FILETIME. Stored as whole microseconds since the Unix epoch, which stays
//    an exact JavaScript integer (the raw FILETIME, 100 ns since 1601, does not).
//  - the PARENT and the NAME, for the climb past a shell (`cli/beacon.ts` `agentPidOf`): one Toolhelp
//    snapshot (`CreateToolhelp32Snapshot` + `Process32FirstW`/`Process32NextW`). Windows keeps a parent's
//    pid after the parent ended, and that pid can be reused, so a parent counts only when it started no
//    later than its child. Otherwise the climb stops where it is.
//
// The FFI is opened once, on first use, and only on win32. Every failure (no kernel32, a pid that is gone,
// access denied, a short read) is null, and the callers already read null as "no start time".

import { dlopen, FFIType } from "bun:ffi";

import type { ProcessInfo } from "../cli/beacon.ts";

/** FILETIME of 1970-01-01T00:00:00Z: 100 ns intervals since 1601-01-01. */
const UNIX_EPOCH_FILETIME = 116_444_736_000_000_000n;

/**
 * A creation FILETIME as whole microseconds since the Unix epoch, or null for a time before 1970 or a
 * value no safe integer holds. The start-time unit on Windows (`bridge/beacon/liveness.ts`).
 */
export function filetimeToMicros(filetime: bigint): number | null {
  if (filetime <= UNIX_EPOCH_FILETIME) return null;
  const micros = (filetime - UNIX_EPOCH_FILETIME) / 10n;
  return micros <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(micros) : null;
}

/** One process in a Toolhelp snapshot: its pid, its parent's pid, its executable's file name. */
export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly exe: string;
}

/**
 * `sizeof(PROCESSENTRY32W)` on x64, the only Windows build Collie ships (ADR 0075). The offsets below
 * are that layout: `th32ProcessID` at 8, `th32ParentProcessID` at 32, `szExeFile` (260 UTF-16 units) at 44.
 */
export const PROCESS_ENTRY_SIZE = 568;
const PID_OFFSET = 8;
const PPID_OFFSET = 32;
const EXE_OFFSET = 44;
const EXE_UNITS = 260;

/** One `PROCESSENTRY32W` as a {@link ProcessEntry}, or null when the buffer is short or the name empty. */
export function parseProcessEntry(bytes: Uint8Array): ProcessEntry | null {
  if (bytes.byteLength < PROCESS_ENTRY_SIZE) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const units: number[] = [];
  for (let at = 0; at < EXE_UNITS; at += 1) {
    const unit = view.getUint16(EXE_OFFSET + at * 2, true);
    if (unit === 0) break;
    units.push(unit);
  }
  const exe = String.fromCharCode(...units);
  if (exe === "") return null;
  return { pid: view.getUint32(PID_OFFSET, true), ppid: view.getUint32(PPID_OFFSET, true), exe };
}

/**
 * An executable's name as the climb compares it: lower case, with no `.exe`. So `bash.exe`, `cmd.exe`
 * and `pwsh.exe` meet the same shell names Linux and macOS report (`cli/beacon.ts` `SHELL_COMMS`).
 */
export function commOfExe(exe: string): string {
  const lower = exe.toLowerCase();
  return lower.endsWith(".exe") ? lower.slice(0, -".exe".length) : lower;
}

/** What the two answers below need from Windows. A seam, so the rules run under `bun test` on Linux. */
export interface Win32ProcessApi {
  /** The creation FILETIME of the RUNNING process holding `pid`, or null (gone, ended, denied). */
  creationTime(pid: number): bigint | null;
  /** Every process right now, or null when no snapshot could be taken. */
  snapshot(): readonly ProcessEntry[] | null;
}

/** A pid's start time in microseconds since the Unix epoch, or null. */
export function startTimeVia(api: Win32ProcessApi, pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const created = api.creationTime(pid);
  return created === null ? null : filetimeToMicros(created);
}

/**
 * A pid's name and parent, or null. The parent is reported only when it still runs and started no later
 * than the child: a parent that ended may have left its pid to a newer process, and climbing to that
 * process would bind a beacon to a stranger. In that case `ppid` is 0, which ends the climb here.
 */
export function processInfoVia(api: Win32ProcessApi, pid: number): ProcessInfo | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const entry = api.snapshot()?.find((row) => row.pid === pid);
  if (entry === undefined) return null;
  const comm = commOfExe(entry.exe);
  const child = api.creationTime(pid);
  const parent = entry.ppid > 0 ? api.creationTime(entry.ppid) : null;
  const parentIsOlder = child !== null && parent !== null && parent <= child;
  return { comm, ppid: parentIsOlder ? entry.ppid : 0 };
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const STILL_ACTIVE = 259;
const TH32CS_SNAPPROCESS = 0x2;
const INVALID_HANDLE_VALUE = 0xffff_ffff_ffff_ffffn;
/** A machine runs a few hundred processes; this bounds a snapshot walk that never ends. */
const SNAPSHOT_MAX = 65_536;

function openKernel32() {
  return dlopen("kernel32.dll", {
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
    GetExitCodeProcess: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    GetProcessTimes: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.u64 },
    Process32FirstW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    Process32NextW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
}

type Kernel32 = ReturnType<typeof openKernel32>;

/** kernel32 behind the {@link Win32ProcessApi} seam. Called only on win32. */
export function kernel32Api(k: Kernel32 = openKernel32()): Win32ProcessApi {
  return {
    creationTime(pid) {
      const handle = BigInt(k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid));
      if (handle === 0n) return null;
      try {
        const code = new Uint32Array(1);
        if (k.GetExitCodeProcess(handle, code) === 0 || code[0] !== STILL_ACTIVE) return null;
        // Four separate FILETIMEs, never views of one array: each pointer is its own buffer's start.
        const [created, exited, kernel, user] = [new BigUint64Array(1), new BigUint64Array(1), new BigUint64Array(1), new BigUint64Array(1)];
        if (k.GetProcessTimes(handle, created, exited, kernel, user) === 0) return null;
        return created[0] ?? null;
      } finally {
        k.CloseHandle(handle);
      }
    },
    snapshot() {
      const handle = BigInt(k.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
      if (handle === 0n || handle === INVALID_HANDLE_VALUE) return null;
      try {
        const entries: ProcessEntry[] = [];
        const bytes = new Uint8Array(PROCESS_ENTRY_SIZE);
        new DataView(bytes.buffer).setUint32(0, PROCESS_ENTRY_SIZE, true);
        let more = k.Process32FirstW(handle, bytes) !== 0;
        while (more && entries.length < SNAPSHOT_MAX) {
          const entry = parseProcessEntry(bytes);
          if (entry !== null) entries.push(entry);
          more = k.Process32NextW(handle, bytes) !== 0;
        }
        return entries;
      } finally {
        k.CloseHandle(handle);
      }
    },
  };
}

let shared: Win32ProcessApi | null | undefined;

/** The one kernel32 seam of this process, or null where it cannot be opened. */
function sharedApi(): Win32ProcessApi | null {
  if (shared !== undefined) return shared;
  try {
    shared = kernel32Api();
  } catch {
    shared = null;
  }
  return shared;
}

/** A running pid's start time on Windows, in microseconds since the Unix epoch, or null. Never throws. */
export function win32StartTime(pid: number): number | null {
  try {
    const live = sharedApi();
    return live === null ? null : startTimeVia(live, pid);
  } catch {
    return null;
  }
}

/** A pid's name and (checked) parent on Windows, or null. Never throws. */
export function win32ProcessInfo(pid: number): ProcessInfo | null {
  try {
    const live = sharedApi();
    return live === null ? null : processInfoVia(live, pid);
  } catch {
    return null;
  }
}
