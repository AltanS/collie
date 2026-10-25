// THE PROCESS PROBE, IN ITS REAL IMPLEMENTATIONS — one definition for the writer and the reader.
//
// A beacon, an edge and a hold request each carry `pid` plus `pidStartTime`; the bridge answers "is
// this still the same process?" by probing the pid again. Those two sides MUST measure the same way,
// so both go through this module: `cli/` (the emitter and the hooks, the writer) and
// `bridge/beacon-io.ts` (the reader's `BeaconLiveness`). The DECODING is `bridge/beacon/liveness.ts`,
// which stays pure; this module is where bytes are read, and so it lives beside `beacon-io.ts`, not
// under `bridge/beacon/`. It is a separate file only because `cli/beacon.ts` needs it and
// `beacon-io.ts` imports `cli/hooks.ts`, which imports `cli/beacon.ts`: one more file breaks the loop.
//
//  - Linux: `/proc/<pid>/stat` (start time in clock ticks since boot) and `/proc/<pid>/cmdline`.
//  - macOS: libproc's `proc_pidinfo(PROC_PIDTBSDINFO)` through Bun FFI (start time in microseconds
//    since the epoch) and `sysctl(KERN_PROCARGS2)` for argv. The first use CHECKS the ABI against this
//    very process (size 136, pid echoed, a start time that is a real instant not in the future); a
//    host where that fails answers null forever. Null is "cannot confirm", which every caller already
//    treats as expired, absent or no edge — never as a guess.
//  - Anything else (Windows, BSD): null.
//
// Every call is synchronous and never throws.

import { dlopen, FFIType, ptr } from "bun:ffi";
import { readFileSync } from "node:fs";

import {
  DARWIN_BSDINFO_SIZE,
  DARWIN_PROC_PIDTBSDINFO,
  parseDarwinBsdInfo,
  parseDarwinProcArgs,
  parseProcStartTime,
  parseProcStat,
  procStatPath,
  type ProcessIdentity,
} from "./beacon/liveness.ts";

/** What a caller may ask about a process. Absent facts are null, never a default. */
export interface ProcessProbe {
  /** The pid's start time in this host's unit, or null when it cannot be confirmed. */
  startTimeOf(pid: number): number | null;
  /** The pid, its parent, its start time and its short name, or null. */
  identityOf(pid: number): ProcessIdentity | null;
  /** The process's argv, or null (another user's process, gone, or a host with no way to read it). */
  argsOf(pid: number): string[] | null;
}

/** A probe that knows nothing: the answer on a host with no way to ask. */
export const NO_PROBE: ProcessProbe = {
  startTimeOf: () => null,
  identityOf: () => null,
  argsOf: () => null,
};

/** The text of a file, or null: the seam the Linux probe reads `/proc` through. */
export type TextReader = (path: string) => string | null;

const readText: TextReader = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** The Linux probe over a `/proc` reader. Production reads the real one; a test passes fixtures. */
export function linuxProbe(read: TextReader = readText): ProcessProbe {
  return {
    startTimeOf(pid) {
      const text = read(procStatPath(pid));
      return text === null ? null : parseProcStartTime(text);
    },
    identityOf(pid) {
      const text = read(procStatPath(pid));
      const stat = text === null ? null : parseProcStat(text);
      return stat === null ? null : { pid, ...stat };
    },
    argsOf(pid) {
      const text = read(`/proc/${String(pid)}/cmdline`);
      if (text === null || text === "") return null;
      const parts = text.split("\u0000");
      if (parts.at(-1) === "") parts.pop();
      return parts;
    },
  };
}

// ── macOS ─────────────────────────────────────────────────────────────────────────────────────

/** The raw calls the macOS probe needs. Fakeable: a test hands it bytes, production hands it libproc. */
export interface DarwinCalls {
  /** `proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, buffer, size)`: the bytes it returned, or null on failure. */
  bsdInfo(pid: number): Uint8Array | null;
  /** `sysctl({CTL_KERN, KERN_PROCARGS2, pid})`: the bytes it returned, or null. */
  procArgs(pid: number): Uint8Array | null;
}

/** The macOS probe over the raw calls. Checks the ABI once, against this very process. */
export function darwinProbe(calls: DarwinCalls, now: () => number = Date.now, self: number = process.pid): ProcessProbe {
  const identityOf = (pid: number): ProcessIdentity | null => {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      const bytes = calls.bsdInfo(pid);
      return bytes === null ? null : parseDarwinBsdInfo(bytes, pid);
    } catch {
      return null;
    }
  };
  // A probe that cannot read ITSELF, or reads a start time in the future, is not decoding this ABI.
  let trusted: boolean | null = null;
  const abiHolds = (): boolean => {
    if (trusted !== null) return trusted;
    const own = identityOf(self);
    trusted = own !== null && own.startTime <= (now() + 2000) * 1000;
    return trusted;
  };
  return {
    startTimeOf: (pid) => (abiHolds() ? (identityOf(pid)?.startTime ?? null) : null),
    identityOf: (pid) => (abiHolds() ? identityOf(pid) : null),
    argsOf(pid) {
      if (!abiHolds() || !Number.isInteger(pid) || pid <= 0) return null;
      try {
        const bytes = calls.procArgs(pid);
        return bytes === null ? null : parseDarwinProcArgs(bytes);
      } catch {
        return null;
      }
    },
  };
}

/** `KERN_PROCARGS2` can be as large as `kern.argmax`; 1 MiB is macOS's default and its usual value. */
const PROCARGS_BUFFER = 1 << 20;

/**
 * libproc and sysctl through Bun FFI, or null when FFI or the symbols are not there. Only the macOS
 * branch of {@link processProbeFor} calls it, so no other host ever `dlopen`s anything.
 */
function darwinFfiCalls(): DarwinCalls | null {
  try {
    const lib = dlopen("libSystem.B.dylib", {
      proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    });
    return {
      bsdInfo(pid) {
        const buffer = new Uint8Array(DARWIN_BSDINFO_SIZE);
        const written = lib.symbols.proc_pidinfo(pid, DARWIN_PROC_PIDTBSDINFO, 0n, ptr(buffer), DARWIN_BSDINFO_SIZE);
        // Exactly the struct's size, or it is not the struct decoded here.
        return written === DARWIN_BSDINFO_SIZE ? buffer : null;
      },
      procArgs(pid) {
        const mib = new Int32Array([1, 49, pid]);
        const buffer = new Uint8Array(PROCARGS_BUFFER);
        const length = new BigUint64Array([BigInt(PROCARGS_BUFFER)]);
        const rc = lib.symbols.sysctl(ptr(mib), 3, ptr(buffer), ptr(length), null, 0n);
        return rc === 0 ? buffer.subarray(0, Number(length[0])) : null;
      },
    };
  } catch {
    return null;
  }
}

/** The probe for a platform. Built once per name: the macOS one holds its ABI verdict. */
const built = new Map<string, ProcessProbe>();
export function processProbeFor(platform: NodeJS.Platform | string): ProcessProbe {
  const known = built.get(platform);
  if (known !== undefined) return known;
  let probe: ProcessProbe = NO_PROBE;
  if (platform === "linux") probe = linuxProbe();
  if (platform === "darwin") {
    const calls = darwinFfiCalls();
    if (calls !== null) probe = darwinProbe(calls);
  }
  built.set(platform, probe);
  return probe;
}

/** This host's probe. Production reads this and passes it down; the seams below take one as a parameter. */
export const hostProcessProbe = (): ProcessProbe => processProbeFor(process.platform);
