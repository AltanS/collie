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
