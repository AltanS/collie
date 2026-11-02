// The pid-reuse guard's UNIT, defined once — what `BeaconRecord.pidStartTime` actually holds.
//
// `types.ts` says the field is "the pid's process start time, in whatever unit the platform probe
// reports", which is only safe while the emitter and the reader use the SAME probe. Two
// implementations that agree today are not that guarantee, so the probe lives here: the emitter
// (`cli/beacon.ts`) stores what {@link startTimeProbe} answers, and the reader's `BeaconLiveness`
// seam (M11/03, `bridge/beacon-io.ts`) answers with the same probe. A mismatch would make every live
// beacon read expired, silently.
//
// TWO PLATFORM PROBES, ONE MODULE (M80 spec 11, issue 647), in {@link startTimeProbe}:
//
//  - Linux: field 22 of `/proc/<pid>/stat`, clock ticks since boot. One file read, unchanged since
//    M11, so a beacon written before the update still reads live after it.
//  - macOS: `ps -o lstart= -p <pid>`, the absolute start to the second, as epoch seconds. macOS has
//    no `/proc`, so this is one subprocess (about 20 ms), run only when there is no stat file. NOT
//    `ps -o etime=` (`bridge/journal/process-start.ts`): elapsed time turned into a start moves by a
//    second between two reads, so it is no identity.
//
// Every other platform (Windows) has no probe: the emitter writes no beacon there, and the reader
// reads none live. The two units never meet: a beacon is read on the host that wrote it.
//
// NO FILESYSTEM CALL AND NO SUBPROCESS, exactly like the rest of `bridge/beacon/`: this module says
// where to read, what to run and how to parse it, and the caller's own seam does the reading.

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

/**
 * The `ps` run that answers a pid's start on macOS. Absolute `/bin/ps`, so a PATH entry cannot stand
 * in for it. `LC_ALL=C` fixes the English names `parseLstart` reads; `TZ=UTC0` fixes the zone, so a
 * daylight-saving change cannot rewrite the line of a process that is still running, and no hour
 * is ever ambiguous. The timeout keeps the hook inside `SessionEnd`'s 1.5 s.
 */
export interface StartTimeCommand {
  readonly file: string;
  readonly args: (pid: number) => readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly parse: (text: string) => number | null;
}

/**
 * How a host reads a pid's start time. The stat file is read first on every host: where `/proc`
 * exists it answers, and nothing is run. Only when there is no stat file does the command run, and
 * only macOS has one. So Linux never runs `ps`, and macOS, which has no `/proc`, always does.
 */
export interface StartTimeProbe {
  readonly stat: { readonly path: (pid: number) => string; readonly parse: (text: string) => number | null };
  /** Run when the stat file is absent: {@link PS_LSTART} on macOS, null on every other platform. */
  readonly command: StartTimeCommand | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** `Mon Nov  2 10:15:33 2026`: weekday, month, day (space padded), time, year, in the C locale. */
const LSTART = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) ([A-Z][a-z]{2}) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/u;

/**
 * One `ps -o lstart=` line (C locale, zone UTC, see {@link StartTimeCommand}) as epoch seconds, or
 * null when the text is empty or not that line. A day with one digit is padded with a second space
 * (`Nov  2`). The weekday is read for its shape only: the date already says which day it was.
 */
export function parseLstart(text: string): number | null {
  const match = LSTART.exec(text.trim());
  if (match === null) return null;
  const [, monthName, day, hours, minutes, seconds, year] = match;
  const month = MONTHS.findIndex((name) => name === monthName);
  if (month < 0) return null;
  const parts = [Number(year), month, Number(day), Number(hours), Number(minutes), Number(seconds)] as const;
  const ms = Date.UTC(...parts);
  const back = new Date(ms);
  // A date that does not exist (`Feb 30`, `25:00:00`) rolls over in Date.UTC; refuse it instead.
  const same =
    back.getUTCFullYear() === parts[0] &&
    back.getUTCMonth() === parts[1] &&
    back.getUTCDate() === parts[2] &&
    back.getUTCHours() === parts[3] &&
    back.getUTCMinutes() === parts[4] &&
    back.getUTCSeconds() === parts[5];
  return same ? ms / 1000 : null;
}

/** macOS's probe. One definition, read by the emitter, the reader and the hook-target registration. */
export const PS_LSTART: StartTimeCommand = {
  file: "/bin/ps",
  args: (pid) => ["-o", "lstart=", "-p", String(pid)],
  env: { LC_ALL: "C", TZ: "UTC0" },
  timeoutMs: 1000,
  parse: parseLstart,
};

/**
 * How `platform` reads a pid's start time. The emitter, the reader and the hook-target registration
 * all ask this, so they cannot drift: the stat file, then `ps -o lstart=` on macOS only.
 */
export function startTimeProbe(platform: NodeJS.Platform): StartTimeProbe {
  return { stat: { path: procStatPath, parse: parseProcStartTime }, command: platform === "darwin" ? PS_LSTART : null };
}

/** Whether `platform` has a start-time probe at all: Linux and macOS. Elsewhere no beacon is ever written. */
export function hasStartTimeProbe(platform: NodeJS.Platform): boolean {
  return platform === "linux" || startTimeProbe(platform).command !== null;
}
