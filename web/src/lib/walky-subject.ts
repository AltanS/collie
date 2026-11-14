// The typed WalkyTalky line's fields, the one rule the bridge and the phone share: the subject (M98 spec
// 07) and the sender fields. The bridge cleans them and writes the line (bridge/walky/types.ts); both
// parsers read it back with readHeaderPart. Pure: no import, so the bridge can load it.
//
// ── AN ALLOW-LIST ────────────────────────────────────────────────────────────
// The subject is the first text of another agent that lands in an input box. If the agent exited between
// the address check and the keys, that box is a shell prompt. So a subject holds only characters that do
// nothing inside a double-quoted shell word: letters, digits, the space and `. , - _ / # + ' ? % @ =`.
// No backtick or `$` (substitution, which zsh runs even on a line it then refuses for a bad pattern),
// no `!` (history expansion), no `"` or `\` (they end or escape the quotes), no `:` (the nudge mark starts
// with one), no bracket or parenthesis (they framed the sender until 1.29.0), no `;`, `|`, `&`, `<`, `>`, `*`, `~` or
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

// ── THE SENDER ON THE LINE (fix/walky-line-fields) ───────────────────────────
// The typed line names its sender in words: `from agent <address> on <harness> in "<label>"`, or
// `from agent <address> in "<label>"` with no harness, or `from operator "<label>"`. Until 1.29.0 it was
// `<address> (<harness>, <label>)`, and fish runs a parenthesis as a command substitution, so a label
// such as `touch canary` ran when the line reached a fish prompt. Now no value stands where a shell runs
// a command: the first word is the fixed `[walky-talky`, the address and the harness are bare words of
// LINE_WORD_CLASS, and the label and the subject sit inside double quotes that nothing in them can end.
//
// A line field holds letters, digits and these, and every other character becomes `_` (so two different
// labels collide no more than needed, and a reader sees that something was there):
//   space   a label is a folder or branch name or a pane title (only the label keeps it, inside quotes)
//   .       folder names, versions in branch names (`release-1.29`), harness names (`a.b`)
//   ,       a branch or a pane title may hold one; inert outside braces, and braces are never kept
//   _       zellij `terminal_7`, folder names; also the replacement mark
//   /       branch names (`feat/x`), the address separator (`<member>/<pane>`)
//   #       Collie's own `<repo>#<branch>` label and an address's `#<token>`; mid-word it is text
//   +       a pane id may hold it (address.ts PANE_ID), branch names (`c++`)
//   @       a pane id may hold it (PANE_ID)
//   =       a pane id may hold it (PANE_ID)
//   :       Herdr's pane ids (`w6:p3`)
//   %       tmux's pane ids (`%7`)
//   -       names of every kind, tuios's UUID pane ids, member ids
// Never kept: ( ) [ ] { } < > ; | & ^ " ' ` \ * ? ~ ! $, a control character, a newline, a Unicode line
// or paragraph separator, a bidi control, anything outside ASCII.

/** The characters a sender field keeps on the typed line, as the body of a RegExp class. `-` last. */
export const LINE_FIELD_CHAR_CLASS = "A-Za-z0-9 .,_/#+@=:%-";
/** The same without the space: the address and the harness stand as one bare word each. */
export const LINE_WORD_CHAR_CLASS = "A-Za-z0-9.,_/#+@=:%-";

const LINE_ALLOWED = new RegExp(`^[${LINE_FIELD_CHAR_CLASS}]$`, "u");

/**
 * A sender field as the typed line carries it: every character outside {@link LINE_FIELD_CHAR_CLASS}
 * becomes `_`, runs of spaces become one, the ends are trimmed, at most `max` characters; `word` turns a
 * space into `_` too. A field left empty is `-`.
 */
export function lineField(raw: string, max: number, word = false): string {
  let out = "";
  for (const ch of raw) out += LINE_ALLOWED.test(ch) && !(word && ch === " ") ? ch : "_";
  const clean = out.replace(/ {2,}/gu, " ").trim();
  const cut = clean.length > max ? clean.slice(0, max).trimEnd() : clean;
  return cut === "" ? "-" : cut;
}

/**
 * The header part of a line in the form since fix/walky-line-fields, anchored at both ends: the sender
 * in words, then {@link AFTER_SENDER}'s parts. Group 1 the address, 2 the harness, 3 the label (agent);
 * an operator's header has the quoted label alone.
 */
const WORDS_SENDER = new RegExp(
  `^(?:([${LINE_WORD_CHAR_CLASS}]+)(?: on ([${LINE_WORD_CHAR_CLASS}]+))? in )?"([${LINE_FIELD_CHAR_CLASS}]*)"( outside)?(?: about "([${SUBJECT_CHAR_CLASS}]+)")?(?: reply to (wt_[a-z0-9]{12}))?$`,
  "u",
);

/** What a header part says after the id and the kind: the sender's text and the parts after it. */
export interface HeaderPart {
  readonly sender: string;
  readonly replyTo: string | null;
  readonly outside?: true;
  readonly subject?: string;
}

/**
 * Read a header part (the text after `from <kind> `, cut before the nudge mark) in either form: the
 * sender in words (the form now typed), or the older `<address> (<harness>, <label>)` whose last closing
 * parenthesis anchors {@link AFTER_SENDER} (what a bridge before this fix types, and what history holds).
 * Null when neither grammar fits: the caller keeps the oldest rule, a reply suffix at the end.
 */
export function readHeaderPart(head: string): HeaderPart | null {
  const words = WORDS_SENDER.exec(head);
  if (words !== null) {
    const subject = words[5];
    if (subject !== undefined && !isCleanSubject(subject)) return null;
    const cut = head.indexOf('"', head.indexOf('"') + 1) + 1;
    return part(head.slice(0, cut), words[6] ?? null, words[4] !== undefined, subject);
  }
  const close = head.lastIndexOf(")");
  const after = close < 0 ? null : AFTER_SENDER.exec(head.slice(close + 1));
  if (after === null) return null;
  const subject = after[2];
  if (subject !== undefined && !isCleanSubject(subject)) return null;
  return part(head.slice(0, close + 1), after[3] ?? null, after[1] !== undefined, subject);
}

function part(sender: string, replyTo: string | null, outside: boolean, subject: string | undefined): HeaderPart {
  const base: HeaderPart = outside ? { sender, replyTo, outside: true } : { sender, replyTo };
  return subject === undefined ? base : { ...base, subject };
}
