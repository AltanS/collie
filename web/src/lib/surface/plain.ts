// The screen as a multiplexer that hands out plain text shows it (M78 spec 01): herdr-core's
// `terminal.read` carries no escape byte, so the Surface must read a screen with the colour gone.

/** One SGR sequence: ESC, `[`, digits and `;` or `:`, then `m`. */
// oxlint-disable-next-line no-control-regex -- matching the escape byte is the point.
const SGR = /\u001b\[[0-9;:]*m/gu;

/**
 * A captured buffer with its SGR sequences (ESC [ ... m) removed. Every other byte stays: a cursor
 * move, a line feed and the text itself pass through, so a stripped buffer has the same rows and the
 * same cell text as the styled one.
 */
export function stripSgr(raw: string): string {
  return raw.replace(SGR, "");
}
