// The subject of a WalkyTalky message (M98 spec 07), the one rule the bridge and the phone share. The
// bridge cleans a sender's subject and writes it into the typed line (bridge/walky/types.ts); both
// parsers read it back from that line with AFTER_SENDER. Pure: no import, so the bridge can load it.
//
// ── AN ALLOW-LIST ────────────────────────────────────────────────────────────
// The subject is the first text of another agent that lands in an input box. If the agent exited between
// the address check and the keys, that box is a shell prompt. So a subject holds only characters that do
// nothing inside a double-quoted shell word: letters, digits, the space and `. , - _ / # + ' ? % @ =`.
// No backtick or `$` (substitution, which zsh runs before the glob error the sender's parentheses cause),
// no `!` (history expansion), no `"` or `\` (they end or escape the quotes), no `:` (the nudge mark starts
// with one), no bracket or parenthesis (they frame the sender), no `;`, `|`, `&`, `<`, `>`, `*`, `~` or
// brace. Every other character becomes a space.

/** The most words a subject holds, after cleaning. */
export const WALKY_SUBJECT_WORDS = 6;
/** The most characters a subject holds, after cleaning. */
export const WALKY_SUBJECT_MAX = 48;

/** The allowed characters, as the body of a RegExp character class. The `-` is last, so it is literal. */
export const SUBJECT_CHAR_CLASS = "A-Za-z0-9 .,_/#+'?%@=-";

const ALLOWED = new RegExp(`^[${SUBJECT_CHAR_CLASS}]$`, "u");

/**
 * What may follow the sender's closing parenthesis in a header, anchored at both ends, each part at most
 * once and in this order: the word `outside` (M98), the subject in quotes, the reply suffix. A subject
 * holds only {@link SUBJECT_CHAR_CLASS}, so it cannot close its quotes early, hold a parenthesis that
 * moves the anchor, or hold the nudge mark.
 */
export const AFTER_SENDER = new RegExp(`^( outside)?(?: about "([${SUBJECT_CHAR_CLASS}]+)")?(?: reply to (wt_[a-z0-9]{12}))?$`, "u");

/**
 * A subject as the header may carry it: every character outside the allow-list becomes a space, runs of
 * spaces become one, the ends are trimmed. The empty string when nothing is left. It never cuts.
 */
export function cleanSubject(raw: string): string {
  let out = "";
  for (const ch of raw) out += ALLOWED.test(ch) ? ch : " ";
  return out.replace(/ {2,}/gu, " ").trim();
}

/** Whether a value is a subject exactly as the bridge leaves one: clean, not empty, within both limits. */
export function isCleanSubject(value: string): boolean {
  return value !== "" && cleanSubject(value) === value && value.length <= WALKY_SUBJECT_MAX && value.split(" ").length <= WALKY_SUBJECT_WORDS;
}
