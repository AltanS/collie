import { redactText } from "./redact.ts";

// ── WHEN A LINE A PERSON TYPED IS NOT KEPT ──────────────────────────────────────────────────────
//
// Two records keep lines a person sent from the phone: the one-off command history (ADR 0095,
// bridge/recent-runs.ts) and Sent, the per-machine record of shell lines (ADR 0107, bridge/sent.ts).
// Both run the line as usual and decide only whether a copy stays on disk. The tests live here, once,
// so a shape one record skips the other skips too.
//
// ── A GUESS THAT ERRS TOWARDS KEEPING TOO LITTLE ────────────────────────────────────────────────
// A line it skips is typed again; a line it keeps can leak. `make FOO=1` is therefore not kept, and
// that is accepted. It still misses a password passed as a plain argument (`mysql -pPASS`) and any
// secret with no known shape, so neither record may be described as one that keeps no secret.

const ASSIGNMENT = /(?:^|[\s;&|(])[A-Za-z_][A-Za-z0-9_]*=\S/;
const URL_PASSWORD = /:\/\/[^\s/@:]+:[^\s/@]+@/;
const SECRET_WORD = /password|passwd|secret|token|api[-_]?key|bearer|authorization|credential/i;

/**
 * Whether a line seems to carry a secret: an assignment word (`NAME=value`, at the start or after a
 * space, `;`, `&`, `|` or `(`), a URL with a password (`scheme://user:pass@`), or one of the words
 * password, passwd, secret, token, api key, bearer, authorization and credential, in any case.
 */
export function looksSecret(line: string): boolean {
  return ASSIGNMENT.test(line) || URL_PASSWORD.test(line) || SECRET_WORD.test(line);
}

/** The longest line Sent keeps. A longer line is sent as usual and not recorded. */
export const SENT_MAX_LINE = 4096;

/**
 * The line Sent keeps for `raw`, the text exactly as it was sent, or `null` when it keeps nothing.
 *
 * Nothing is kept when the text starts with a space or a tab (checked on the raw text, before any
 * trim, the way a shell's `HISTCONTROL=ignorespace` reads it), is empty after a trim, holds a line
 * break, is longer than {@link SENT_MAX_LINE}, {@link looksSecret}, or would change under the
 * outbound mask (`bridge/redact.ts`), which is how a vendor key such as a `ghp_` token is caught.
 * The kept line is the text with its trailing blanks cut.
 */
export function sentLineOf(raw: string): string | null {
  if (raw.startsWith(" ") || raw.startsWith("\t")) return null;
  const line = raw.trim();
  if (line === "" || /[\r\n]/u.test(line) || line.length > SENT_MAX_LINE) return null;
  if (looksSecret(line) || redactText(line) !== line) return null;
  return line;
}
