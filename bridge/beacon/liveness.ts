// The pid-reuse guard's UNIT, defined once — what `BeaconRecord.pidStartTime` actually holds.
//
// `types.ts` says the field is "the pid's process start time, in whatever unit the platform probe
// reports", which is only safe while the emitter and the reader use the SAME probe. Two
// implementations that agree today are not that guarantee, so the probe's parse lives here: the
// emitter (`cli/beacon.ts`) stores what this function returns, and the reader's `BeaconLiveness`
// seam (M11/03) answers with what this function returns. A mismatch would make every live beacon
// read expired, silently.
//
// NO FILESYSTEM CALL, exactly like the rest of `bridge/beacon/`: this module says where to read and
// how to read it, and the caller's own seam does the reading.

/** Linux's per-process status line. The only platform with a start time behind one cheap read. */
export const procStatPath = (pid: number): string => `/proc/${pid}/stat`;

/**
 * Field 22 of `/proc/<pid>/stat` — the process's start time in clock ticks since boot — or null when
 * the text is not a stat line.
 *
 * Parsed from the LAST `)` rather than by splitting the whole line: field 2 is the executable's name
 * in parentheses and may itself contain spaces and parentheses (`(my app (2))`), so every parser that
 * splits on whitespace from the left is wrong for exactly the processes an attacker gets to name.
 * After that bracket the fields are positional: index 0 is field 3 (state), so field 22 is index 19.
 */
export function parseProcStartTime(text: string): number | null {
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  const fields = text.slice(close + 1).trim().split(/\s+/u);
  const raw = fields[19];
  if (raw === undefined || !/^\d+$/u.test(raw)) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

// ── macOS: libproc's `proc_bsdinfo` ─────────────────────────────────────────────
//
// macOS has no `/proc`. Its one cheap, in-process source of a start time is
// `proc_pidinfo(pid, PROC_PIDTBSDINFO, ...)`, which fills a `struct proc_bsdinfo`. This module only
// DECODES the bytes (no call, no file): `bridge/proc-probe.ts` makes the call and hands them here, so
// the writer (`cli/`) and the reader (`bridge/beacon-io.ts`) take the unit from one definition, as
// they do for Linux above.
//
// The unit is MICROSECONDS SINCE THE EPOCH (`pbi_start_tvsec * 1e6 + pbi_start_tvusec`), the kernel's
// own process start. It is a different unit from Linux's clock ticks since boot, and that is fine
// for the same reason a tick count is: a beacon is only ever compared with a probe of the SAME host.
//
// The layout, from `<sys/proc_info.h>` (little endian on both arm64 and x86_64), 136 bytes:
//
//   0 flags u32 · 4 status u32 · 8 xstatus u32 · 12 pid u32 · 16 ppid u32 · 20 uid · 24 gid ·
//   28 ruid · 32 rgid · 36 svuid · 40 svgid · 44 rfu · 48 comm[16] · 64 name[32] · 96 nfiles ·
//   100 pgid · 104 pjobc · 108 e_tdev · 112 e_tpgid · 116 nice i32 ·
//   120 start_tvsec u64 · 128 start_tvusec u64

/** `PROC_PIDTBSDINFO`: the `proc_pidinfo` flavor that fills a {@link DARWIN_BSDINFO_SIZE}-byte `proc_bsdinfo`. */
export const DARWIN_PROC_PIDTBSDINFO = 3;

/** `sizeof(struct proc_bsdinfo)`. The call must return exactly this many bytes, or the ABI is not the one decoded here. */
export const DARWIN_BSDINFO_SIZE = 136;

/** What the kernel knows of one process, in the units the writer and the reader share. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly ppid: number;
  /** The process start time in the probe's unit (see the section header). */
  readonly startTime: number;
  /** The executable's short name (`pbi_comm` on macOS, the stat line's comm on Linux). */
  readonly comm: string;
}

/** The NUL-terminated ASCII string in `bytes[from, from + max)`, or null when it holds a byte a name cannot. */
function cString(bytes: Uint8Array, from: number, max: number): string | null {
  let end = from;
  while (end < from + max && bytes[end] !== 0) end += 1;
  let text = "";
  for (let i = from; i < end; i += 1) {
    const byte = bytes[i]!;
    if (byte < 0x20 || byte > 0x7e) return null;
    text += String.fromCharCode(byte);
  }
  return text;
}

/** One second in microseconds, and the latest second a plausible start time may name (year 2200). */
const MICROS = 1_000_000;
const SECONDS_MAX = 7_258_118_400;

/**
 * Decodes a `proc_bsdinfo`, or null when the bytes are not one for `expectedPid`. Every check is an
 * ABI check: the length is the struct's, the pid the kernel echoes is the one asked for (a shifted
 * layout would put a different word there), and the start time is a real instant. Null on any doubt,
 * because a start time that is wrong is worse than none — it expires every live beacon.
 */
export function parseDarwinBsdInfo(bytes: Uint8Array, expectedPid: number): ProcessIdentity | null {
  if (bytes.length !== DARWIN_BSDINFO_SIZE) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pid = view.getUint32(12, true);
  if (pid !== expectedPid) return null;
  const ppid = view.getUint32(16, true);
  const seconds = view.getBigUint64(120, true);
  const micros = view.getBigUint64(128, true);
  if (seconds <= 0n || seconds > BigInt(SECONDS_MAX) || micros >= BigInt(MICROS)) return null;
  const comm = cString(bytes, 48, 16);
  if (comm === null) return null;
  return { pid, ppid, startTime: Number(seconds) * MICROS + Number(micros), comm };
}

// ── Linux: the rest of the stat line ─────────────────────────────────────────────

/** Field 4 (the parent pid) and field 2 (the comm) of `/proc/<pid>/stat`, with the start time, or null. */
export function parseProcStat(text: string): Omit<ProcessIdentity, "pid"> | null {
  const startTime = parseProcStartTime(text);
  if (startTime === null) return null;
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const fields = text.slice(close + 1).trim().split(/\s+/u);
  const ppid = fields[1];
  if (ppid === undefined || !/^\d+$/u.test(ppid)) return null;
  return { ppid: Number(ppid), startTime, comm: text.slice(open + 1, close) };
}

// ── The arguments of a process (macOS `KERN_PROCARGS2`, Linux `/proc/<pid>/cmdline`) ─────────────

/**
 * The argv of a `KERN_PROCARGS2` buffer: `int32 argc`, the executable path, NUL padding, then `argc`
 * NUL-terminated arguments (the environment follows and is never read). Null when the buffer is
 * shorter than it says. Bounded: a process with a very long argv costs the first 256 arguments.
 */
export function parseDarwinProcArgs(bytes: Uint8Array): string[] | null {
  if (bytes.length < 8) return null;
  const argc = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(0, true);
  if (argc < 0 || argc > 4096) return null;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let at = 4;
  // The executable path, then the padding NULs before argv[0].
  while (at < bytes.length && bytes[at] !== 0) at += 1;
  while (at < bytes.length && bytes[at] === 0) at += 1;
  const argv: string[] = [];
  while (argv.length < Math.min(argc, 256) && at < bytes.length) {
    let end = at;
    while (end < bytes.length && bytes[end] !== 0) end += 1;
    if (end >= bytes.length) return null;
    argv.push(decoder.decode(bytes.subarray(at, end)));
    at = end + 1;
  }
  return argv.length === Math.min(argc, 256) ? argv : null;
}
