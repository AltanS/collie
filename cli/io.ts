// Exit codes and the output seam, in their own module so every verb can import them without
// importing the dispatcher (which imports the verbs).
//
// Exit codes are a contract, ported from `scripts/collie-ctl.sh`:
//   0  success
//   1  operational failure — something we tried, that failed
//   2  usage error — unknown verb, bad argument (the pre-shim collie-ctl.sh)
// Diagnostics go to stderr; machine-readable output (`url`, `version`) to stdout, undecorated.

// The pack verbs add three codes on top, because M4/07 asks for outcomes a script can branch on:
// "joining a pack you are already in, with a spent token, or with an unreachable address each produce
// a distinct, actionable message and a distinct exit code". They are additive — 0/1/2 keep their
// meanings, and every pre-pack verb still only ever returns those three.
//   3  the local state says no — already in a pack, not in a pack, not the lead
//   4  the far side refused — a spent/expired token, a rotated secret, an unpinned certificate
//   5  the far side could not be reached at all
export const EXIT = { OK: 0, FAIL: 1, USAGE: 2, STATE: 3, REFUSED: 4, UNREACHABLE: 5 } as const;

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

export const realIo: Io = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};
