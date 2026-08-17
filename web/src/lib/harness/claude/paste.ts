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
//   * In that split shape the token comes FIRST and the literal tail after it, so the last thing on
//     the row is the last thing that arrived — re-probed 2026-08-17 (collie-demo, pane `w6:p1`,
//     200-col PTY), where a send whose final chunk never landed showed
//     `[Pasted text #3 +5 lines] TAIL-ONE… TAIL-TWO…` and the complete one added `TAIL-THREE…`.
//     Both captures are in the corpus (`claude--draft-paste-split-{partial,tail}.txt`); rule 5 below
//     is what tells them apart.
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
  /** The LAST fragment when the draft ends in literal text rather than in a token — i.e. what the
   *  screen shows as the final thing typed. `null` when the draft ends on a token (or holds no
   *  literal text at all), because then the end of the message is inside a token and invisible. This
   *  is the one place the "is the tail complete?" question can be asked at all. */
  trailing: string | null;
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
  let trailing: string | null = null;
  if (cursor < stripped.length) {
    trailing = stripped.slice(cursor);
    fragments.push(trailing);
  }
  return { tokens, lines, fragments, trailing };
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
 *     token+tail shape, where the tail is the part of our message the chunk boundary left uncollapsed;
 *  5. when the draft ENDS in literal text, that trailing text is the END of what we sent, not merely
 *     somewhere inside it (#110). Rules 2 and 4 both pass a PARTIALLY arrived send: `Σ M ≤ S` is
 *     deliberately loose (the tail's own newlines are not in the token's count, and they cannot be
 *     recovered — the box wraps and `extractInputDraft` space-joins the rows, so no newline survives
 *     to be counted), and a truncated tail is still a prefix-ordered substring, so every `indexOf`
 *     succeeds. The suffix is what distinguishes "the tail we can see is all the tail there is" from
 *     "later chunks are still missing". Live-probed 2026-08-17 (collie-demo, pane `w6:p1`):
 *     `[Pasted text #3 +5 lines] TAIL-ONE… TAIL-TWO…` for a message ending `…TAIL-THREE-echo-foxtrot`
 *     was accepted before this rule and fired Enter on a half-arrived send.
 *
 * A draft that ends ON a token keeps rules 1–4 only: the end of our message is then inside a token,
 * where nothing is visible to compare, and the tightening has nothing to bite on. That residual hole
 * is deliberate — it was never observed (truncation shows up as a literal dribble, not as a collapse),
 * and rejecting a shape we cannot read would convert working sends into permanent stalls, which is the
 * worse failure of the two.
 *
 * Anything inconsistent returns false and the caller keeps today's behaviour: no submit key, draft
 * kept, "didn't reach the input box". Guessing here would fire Enter at a screen we cannot read.
 */
export function pasteCarriesSend(sent: string, draft: string): boolean {
  const d = stripWhitespace(draft);
  const s = stripWhitespace(sent);
  const { tokens, lines, fragments, trailing } = scan(d);
  if (tokens === 0) return false;

  const newlines = countNewlines(sent);
  if (newlines === 0 && sent.length < MIN_COLLAPSIBLE_LENGTH) return false;

  if (lines > newlines) return false;
  if (fragments.length === 0) return lines === newlines;

  // The draft ends in literal text, so the last thing the screen shows IS the last thing that
  // arrived — and it therefore has to be the last thing we sent. Anything else means bytes are still
  // missing (#110). No length exemption here: `extractInputDraft` trims the row, so a trailing scrap
  // that is not the end of our message is a screen we do not understand, not wrap debris.
  if (trailing !== null && !s.endsWith(trailing)) return false;

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
