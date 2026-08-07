// Exit codes and the output seam, in their own module so every verb can import them without
// importing the dispatcher (which imports the verbs).
//
// Exit codes are a contract, ported from `scripts/collie-ctl.sh`:
//   0  success
//   1  operational failure — something we tried, that failed
//   2  usage error — unknown verb, bad argument (scripts/collie-ctl.sh:878)
// Diagnostics go to stderr; machine-readable output (`url`, `version`) to stdout, undecorated.

export const EXIT = { OK: 0, FAIL: 1, USAGE: 2 } as const;

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

export const realIo: Io = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};
