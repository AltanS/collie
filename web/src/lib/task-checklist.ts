// The TASK CHECKLIST Claude Code 2.1.299 draws at the bottom of the screen, and how to tell it from
// output that only looks like one.
//
// While a session has tasks, 2.1.299 keeps their checklist under everything else, a dialog's
// key-hint footer included:
//
//   Enter to select · ↑/↓ to navigate · Esc to cancel
//
//     4 tasks (3 done, 1 in progress, 0 open)
//     ✔ Hygiene pass on CC plan
//     ◼ Orient, slice, explore, build, land, checkpoint
//      … +2 completed
//
// Two readers anchor on the screen's last rows and so need the list taken off first: the phone's
// Claude grammars (harness/claude/task-checklist.ts) and the bridge's binding check
// (bridge/prompt-binding.ts), whose tail window the list would otherwise fill. Both call the one
// function below. It is pure, reads rows of plain text and imports nothing, so the bridge can import
// it by relative path the way it imports styled-region.ts.
//
// FAIL CLOSED. The rows end with a checklist only when all of these hold:
//   1. walking up from the end past blank rows, every row is a checklist row until a header is
//      reached, and at least one row sits under the header;
//   2. the header is the whole row: `N tasks (D done, P in progress, O open)`, the `P in progress`
//      part omitted when P is 0, and `task` for `tasks` allowed;
//   3. a checklist row is a state glyph (`✔` done, `◼` in progress, `◻` open), one space and text,
//      or, as the last row only, the overflow row `… +2 completed` (more parts after `, `; states
//      `completed`, `pending`, `in progress`);
//   4. the rows' counts agree with the header, state by state, and D + P + O = N;
//   5. something non-blank sits above the header.
// The counts are what keep ordinary output that happens to use these glyphs from passing.

const HEADER = /^(\d+) tasks? \((\d+) done, (?:(\d+) in progress, )?(\d+) open\)$/;
const ITEM = /^\s*([✔◼◻]) \S/;
const OVERFLOW_STATE = "(?:completed|pending|in progress)";
const OVERFLOW = new RegExp(`^\\s*… \\+(\\d+ ${OVERFLOW_STATE}(?:, \\d+ ${OVERFLOW_STATE})*)$`);
const OVERFLOW_PART = /^(\d+) (.+)$/;

/** How many tasks are in each state. */
interface Tally {
  done: number;
  inProgress: number;
  open: number;
}

/** What a header row declares: the total and the tally it promises. */
interface Header {
  total: number;
  tally: Tally;
}

function parseHeader(text: string): Header | null {
  const match = HEADER.exec(text.trim());
  if (match === null) return null;
  const [, total, done, inProgress, open] = match;
  return {
    total: Number(total),
    tally: { done: Number(done), inProgress: Number(inProgress ?? "0"), open: Number(open) },
  };
}

/** Add one state glyph or overflow state to `tally`. */
function count(tally: Tally, state: string, n: number): void {
  if (state === "✔" || state === "completed") tally.done += n;
  else if (state === "◼" || state === "in progress") tally.inProgress += n;
  else tally.open += n;
}

/** Count `text` into `tally` when it is a checklist row; false when it is not one. The overflow row
 *  is taken only as the list's last row, where Claude draws it. */
function countRow(text: string, tally: Tally, isLast: boolean): boolean {
  const item = ITEM.exec(text);
  if (item !== null) {
    count(tally, item[1]!, 1);
    return true;
  }
  const overflow = isLast ? OVERFLOW.exec(text) : null;
  if (overflow === null) return false;
  for (const part of overflow[1]!.split(", ")) {
    const [, n, state] = OVERFLOW_PART.exec(part)!;
    count(tally, state!, Number(n));
  }
  return true;
}

function agrees(header: Header, rows: Tally): boolean {
  const { total, tally } = header;
  return (
    rows.done === tally.done &&
    rows.inProgress === tally.inProgress &&
    rows.open === tally.open &&
    tally.done + tally.inProgress + tally.open === total
  );
}

const isBlank = (text: string): boolean => text.trim() === "";

/**
 * The index of the checklist's header row when `rows` END with a Claude task checklist, else null.
 * Trailing blank rows are skipped. See the header comment for the five conditions; any one failing
 * gives null.
 */
export function trailingTaskChecklistStart(rows: readonly string[]): number | null {
  const tally: Tally = { done: 0, inProgress: 0, open: 0 };
  let listed = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const text = rows[i]!.trimEnd();
    if (isBlank(text)) continue;
    const header = parseHeader(text);
    if (header !== null) {
      const somethingAbove = rows.slice(0, i).some((row) => !isBlank(row));
      return listed > 0 && somethingAbove && agrees(header, tally) ? i : null;
    }
    if (!countRow(text, tally, listed === 0)) return null;
    listed++;
  }
  return null;
}
