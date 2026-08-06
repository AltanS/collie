// Claude's PASTE PLACEHOLDER, read as evidence that a long send landed.
//
// The #34 guard (lib/reply-action.ts) only presses the submit key once it can SEE the text it typed
// on the "❯" line. For anything long enough to trip Claude Code's paste heuristic that never happens:
// Claude collapses the incoming bytes into a token of its own —
//
//     [Pasted text #3]              a paste with no newline in it
//     [Pasted text #3 +3 lines]     M = the number of `\n` characters in the paste (60 lines → +59)
//
// — so the box holds a token, not our message, the generic substring match never fires, and the send
// stalls forever. Worse, it stalls RECOVERABLY-looking: every retry sweeps the stranded placeholder,
// re-types, collapses again, stalls again. Reproduced live (2026-08-06, pane `w2H:p1`, three attempts
// ending at `[Pasted text #3 +3 lines]`).
//
// The token is not proof on its own — `#N` is a session-scoped counter we cannot predict, so a
// placeholder left over from someone else's paste looks exactly like ours. What IS checkable is
// whether the screen's token is CONSISTENT with the message we just typed: the line count it
// advertises must be one our text could have produced, and any literal text sitting beside it must be
// our text, in order. That is the whole grammar below.
//
// Facts it is built on (live-probed 2026-08-06, collie-demo sandbox, Claude Code current):
//   * Short pastes (≤ ~400 chars observed) insert LITERALLY, newlines and all — today's plain
//     verification already covers those, and nothing here should engage for them.
//   * A PTY chunk split can leave `placeholder` + a literal tail in one draft (observed:
//     `[Pasted text #1 +3 lines]xxxxx… four`). Rapid consecutive chunks usually merge into ONE
//     placeholder carrying the total newline count.
//   * The token WRAPS arbitrarily inside the box and `extractInputDraft` space-joins wrapped rows, so
//     a wrap can fall mid-token (`…+3 li` / `nes]`). Every match here therefore runs on a
//     whitespace-STRIPPED normalisation — never on the space-joined raw, which would miss the wrap.

/** The token as it appears AFTER all whitespace is stripped — the only form we ever match against. */
const PLACEHOLDER = /\[Pastedtext#\d+(?:\+(\d+)lines)?\]/g;

/**
 * Below this, a single-line send is short enough that Claude would have inserted it literally, so a
 * token on screen is somebody else's. Sits comfortably above the ~400-char threshold we observed —
 * that threshold is unversioned Claude-internal behaviour, so the gate is deliberately pessimistic:
 * being late to accept costs a stall we already have, being early would let a stale placeholder vouch
 * for a message that never arrived.
 */
const MIN_COLLAPSIBLE_LENGTH = 700;

/**
 * Shortest literal fragment worth checking against what we sent. A wrap or a chunk boundary can leave
 * a couple of stray characters beside the token; demanding those match in order would reject a good
 * draft on debris, and accepting them proves nothing either way.
 */
const MIN_FRAGMENT_CHARS = 4;

interface Scan {
  /** How many placeholder tokens the draft holds. */
  tokens: number;
  /** Σ M over those tokens — how many newlines Claude says it swallowed. An M-less token counts 0. */
  lines: number;
  /** The literal text between/around the tokens, in screen order, whitespace already stripped. Never
   *  contains an empty string, so `fragments.length === 0` IS the fully-collapsed shape. */
  fragments: string[];
}

function stripWhitespace(s: string): string {
  return s.replace(/\s+/g, "");
}

/** Split a whitespace-stripped draft into its placeholder tokens and the literal text around them. */
function scan(stripped: string): Scan {
  const re = new RegExp(PLACEHOLDER.source, "g");
  const fragments: string[] = [];
  let tokens = 0;
  let lines = 0;
  let cursor = 0;
  for (let m = re.exec(stripped); m !== null; m = re.exec(stripped)) {
    tokens++;
    lines += m[1] === undefined ? 0 : Number(m[1]);
    if (m.index > cursor) fragments.push(stripped.slice(cursor, m.index));
    cursor = m.index + m[0].length;
  }
  if (cursor < stripped.length) fragments.push(stripped.slice(cursor));
  return { tokens, lines, fragments };
}

/**
 * Whether the input box's visible `draft` is evidence that `sent` reached it, given that Claude
 * collapsed part or all of it into a paste placeholder. SUPPLEMENTAL: the reply guard consults this
 * only after its own literal-substring match has already failed, so a normal send is never routed
 * through this reasoning.
 *
 * Accepts only when every one of these holds:
 *  1. the draft carries at least one placeholder token, AND a collapse is plausible for OUR send —
 *     it has a newline in it, or it is long enough (MIN_COLLAPSIBLE_LENGTH) that a single line would
 *     have tripped the heuristic. Without this gate a stale token from a previous paste would vouch
 *     for a short message that never landed, and the guard would press Enter into whatever has focus;
 *  2. the tokens claim no MORE newlines than we sent (`Σ M ≤ S`) — Claude cannot swallow lines we
 *     never typed;
 *  3. when the draft is NOTHING but tokens (the fully-collapsed shape), the counts match exactly
 *     (`Σ M === S`). For a long single-line send that means S = 0, i.e. the M-less form;
 *  4. every literal fragment beside the tokens appears in what we sent, IN ORDER — the split
 *     token+tail shape, where the tail is the part of our message the chunk boundary left uncollapsed.
 *
 * Anything inconsistent returns false and the caller keeps today's behaviour: no submit key, draft
 * kept, "didn't reach the input box". Guessing here would fire Enter at a screen we cannot read.
 */
export function pasteCarriesSend(sent: string, draft: string): boolean {
  const d = stripWhitespace(draft);
  const s = stripWhitespace(sent);
  const { tokens, lines, fragments } = scan(d);
  if (tokens === 0) return false;

  const newlines = countNewlines(sent);
  if (newlines === 0 && sent.length < MIN_COLLAPSIBLE_LENGTH) return false;

  if (lines > newlines) return false;
  if (fragments.length === 0) return lines === newlines;

  // Chained indexOf: each fragment must occur after the previous one, so a draft that shuffles our
  // words around (a different message that happens to share vocabulary) is rejected.
  let at = 0;
  for (const fragment of fragments) {
    if (fragment.length < MIN_FRAGMENT_CHARS) continue;
    const i = s.indexOf(fragment, at);
    if (i < 0) return false;
    at = i + fragment.length;
  }
  return true;
}

/**
 * Whether the draft on the "❯" line is NOTHING but Claude's own paste token(s) — no literal text of
 * the user's beside them. The stranded-draft preview asks this before offering "Take over": copying
 * `[Pasted text #1 +3 lines]` into the phone composer as literal text is never what anyone wants, and
 * sending it would type that string at the agent. The preview still SHOWS the token (it is honestly
 * what the screen says); only the take-over affordance stands down.
 */
export function isPastePlaceholderOnly(draft: string): boolean {
  const { tokens, fragments } = scan(stripWhitespace(draft));
  return tokens > 0 && fragments.length === 0;
}

function countNewlines(s: string): number {
  let n = 0;
  for (const ch of s) if (ch === "\n") n++;
  return n;
}
