// Exit codes and the output seam, in their own module so every verb can import them without
// importing the dispatcher (which imports the verbs).
//
// Exit codes are a contract, ported from `scripts/collie-ctl.sh`:
//   0  success
//   1  operational failure — something we tried, that failed
//   2  usage error — unknown verb, bad argument (the pre-shim collie-ctl.sh)
// Diagnostics go to stderr; machine-readable output (`url`, `version`) to stdout, undecorated.

// The crew verbs add three codes on top, because M4/07 asks for outcomes a script can branch on:
// "joining a crew you are already in, with a spent token, or with an unreachable address each produce
// a distinct, actionable message and a distinct exit code". They are additive — 0/1/2 keep their
// meanings, and every pre-crew verb still only ever returns those three.
//   3  the local state says no — already in a crew, not in a crew, not the lead
//   4  the far side refused — a spent/expired token, a rotated secret, an unpinned certificate
//   5  the far side could not be reached at all
export const EXIT = { OK: 0, FAIL: 1, USAGE: 2, STATE: 3, REFUSED: 4, UNREACHABLE: 5 } as const;

export interface Io {
  out(line: string): void;
  err(line: string): void;
  /**
   * Whether stderr is a terminal. Read by the one line that is written FOR A HUMAN and for nobody
   * else: the `collie pack` deprecation notice (ADR 0038). Absent means "not a terminal", so every
   * fake io in the tests stays a two-method object and a scripted run is the default.
   */
  readonly errIsTty?: boolean;
}

export const realIo: Io = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  errIsTty: process.stderr.isTTY === true,
};
