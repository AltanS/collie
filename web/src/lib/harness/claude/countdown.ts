// The self-answer countdown Claude Code draws inside a permission dialog in an unattended session.
//
// It prints the time left ("⚠ Claude Code will automatically deny this request in 1:20, to avoid
// blocking progress on an unattended session" in 2.1.306, reworded to "automatically block ... to
// avoid holding up an unattended session" in 2.1.330) and redraws it every second; its other rendering
// says "about 2 minutes" or "about 45 seconds" (both read from the Claude Code binaries). The clock is
// not the question: the ask id reads the sentence as one fixed text, or the id changed under every tap
// and each one was refused `ask_changed` (2026-10-29, six taps on one permission). The whole sentence,
// breaks included: a clock of another width rewraps it, and a break and the box's rule may sit between
// any two words.
//
// An agent writes its own command, so the same words can stand inside the command. Only the dialog's
// OWN countdown is held still and left out of the binding, and the sentence counts as that only when
// all of these hold ({@link ownCountdown}):
//
//   - the rows it touches hold nothing but it: the `⚠` before it, the box's `│` and blanks, no other
//     word on its first row and none after it on its last row ({@link holdsOnlyCountdown});
//   - it is the only match in the dialog's rows, from the edge to the footer;
//   - it stands where Claude Code draws it: the last thing above the question, with only blank rows
//     between its last row and the question's first row. Read from the 2.1.330 binary: the countdown
//     element (marginBottom 1) is the last child of the permission's reason block, or sits right after
//     that block, and the question and its options follow it, in all three places it is drawn. Every
//     capture with the countdown (the 2.1.303 rm permission `claude--v2303-permission-bash-bg-agent-rm`
//     with the sentence under its explanation row, as the owner's phone showed it on 2026-10-29, both
//     wordings, every clock rendering, rewrapped) has it there.
//
// In every other case there is no countdown: the ask id reads the rows as they are and the binding is
// the whole rows, literal. That fails closed: a ticking clock then refuses the tap. The bridge checks
// the rows it was told to skip with {@link holdsOnlyCountdown} too (bridge/prompt-binding.ts).

const W = "[\\s│]+";
const CLOCK = `(?:\\d{1,3}:\\d{2}|about${W}\\d{1,4}${W}(?:minutes?|seconds?))`;
/** The sentence, either wording, whole: the wording pairs are kept (deny with "blocking progress on",
 *  block with "holding up"), so a mixed or reworded sentence ("automatically allow") is not it. */
const SELF_ANSWER_CLOCK = new RegExp(
  `\\bClaude${W}Code${W}will${W}automatically${W}` +
    `(?:deny${W}this${W}request${W}in${W}${CLOCK}[\\s│]*,${W}to${W}avoid${W}blocking${W}progress${W}on` +
    `|block${W}this${W}request${W}in${W}${CLOCK}[\\s│]*,${W}to${W}avoid${W}holding${W}up)` +
    `${W}an${W}unattended${W}session\\b`,
  "gu",
);
/** What the ask id reads in place of the dialog's own countdown. */
export const STEADY_CLOCK = "Claude Code will automatically deny this request in 0:00, to avoid blocking progress on an unattended session";

/** The text on a countdown row before the sentence: the box's gutter, blanks and the `⚠` Claude Code
 *  prints in front of it, nothing else. */
const LEAD = /^[\s│]*⚠️?[\s│]*$/u;
/** The text on a countdown row after the sentence: the box's edge and blanks. */
const TRAIL = /^[\s│]*$/u;

/** One match of the sentence in `joined`, with the rows it touches (0-based, by `\n`). */
interface SentenceMatch {
  index: number;
  length: number;
  firstRow: number;
  lastRow: number;
}

function matchesIn(joined: string): SentenceMatch[] {
  const rowAt = (offset: number) => joined.slice(0, offset).split("\n").length - 1;
  return [...joined.matchAll(SELF_ANSWER_CLOCK)].map((m) => ({
    index: m.index,
    length: m[0].length,
    firstRow: rowAt(m.index),
    lastRow: rowAt(m.index + m[0].length),
  }));
}

/** Whether the rows `match` touches hold nothing but the sentence (see {@link LEAD}, {@link TRAIL}). */
function aloneOnItsRows(joined: string, match: SentenceMatch): boolean {
  const rowStart = joined.lastIndexOf("\n", match.index - 1) + 1;
  const end = match.index + match.length;
  const nextBreak = joined.indexOf("\n", end);
  const rowEnd = nextBreak < 0 ? joined.length : nextBreak;
  return LEAD.test(joined.slice(rowStart, match.index)) && TRAIL.test(joined.slice(end, rowEnd));
}

/**
 * Whether `rows` are exactly one countdown sentence and nothing else: one match, alone on its rows,
 * and touching every row given, first to last. What the bridge requires of the rows a list binding
 * left out between two parts. Blank rows are not expected (the bridge's rows are normalized) and fail.
 */
export function holdsOnlyCountdown(rows: readonly string[]): boolean {
  if (rows.length === 0) return false;
  const joined = rows.join("\n");
  const matches = matchesIn(joined);
  if (matches.length !== 1) return false;
  const only = matches[0]!;
  return only.firstRow === 0 && only.lastRow === rows.length - 1 && aloneOnItsRows(joined, only);
}

/**
 * The dialog's own countdown in `rows` (the dialog's rows, from its edge to its footer), or null when
 * there is none by the rules above. `questionRow` is the index in `rows` of the question's first row.
 * `index` and `length` are the sentence's place in `rows.join("\n")`; `firstRow` and `lastRow` the
 * rows it touches.
 */
export function ownCountdown(rows: readonly string[], questionRow: number): SentenceMatch | null {
  const joined = rows.join("\n");
  const matches = matchesIn(joined);
  if (matches.length !== 1) return null;
  const only = matches[0]!;
  if (!aloneOnItsRows(joined, only)) return null;
  if (only.lastRow >= questionRow) return null;
  for (let r = only.lastRow + 1; r < questionRow; r++) if (rows[r]!.trim().length > 0) return null;
  return only;
}
