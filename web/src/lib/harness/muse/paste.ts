// Muse's PASTE TOKEN, read as evidence that a long send landed.
//
// The #34 guard (lib/reply-action.ts) only presses the submit key once it can SEE the text it typed
// on the "❯" line. For a long enough single line that never happens: Muse collapses the line into a
// token of its own —
//
//     [Pasted Content 1500 chars]
//
// — so the box holds a token, not our message, the generic substring match never fires, and the send
// stalls forever. Same shape as Claude's [.adr/0010], but the semantics are per-LINE, not per-paste
// (this module), which is why it is not shared.
//
// Facts it is built on (live-probed 2026-09-18, collie-muse-sandbox, Muse 1.3.0):
//   * Collapse is PER LINE. A 3003-char single line collapses; a 3300-char burst of short lines
//     stays fully literal; `1500×"q" + "\ntail"` renders as the token plus a literal `tail` row.
//   * N is the collapsed LINE's length in CHARACTERS (code points, not bytes: 1500×"é" → N=1500).
//   * The threshold sits in (1000, 1200]: 800- and 1000-char lines stay literal, 1200 collapses.
//     The gate below sits AT the proven-literal bound, so it cannot strand a send (see below).
//   * The token WRAPS arbitrarily inside the box and `extractInputDraft` space-joins wrapped rows, so
//     a wrap can fall mid-token. Every match here therefore runs on a whitespace-STRIPPED
//     normalisation — never on the space-joined raw, which would miss the wrap.
//
// The token is not proof on its own — N is a length, not content, so a token left over from someone
// else's paste could share our line's length. What IS checkable is whether the screen's token is
// CONSISTENT with the message we just typed: every token's N must be the length of a sent line, long
// sent lines must have their token, and any literal text beside the tokens must be our text, in
// order. That is the whole grammar below.

/** The token as it appears AFTER all whitespace is stripped — the only form we ever match against. */
const PASTE_TOKEN = /\[PastedContent(\d+)chars\]/g;

/**
 * A sent line this long either collapsed (token on screen) or stayed literal — both shapes verify.
 * Sits AT the longest line proven literal (1000 chars: observed literal, never collapsed), which is
 * what makes the gate stall-free rather than merely pessimistic: a line below it cannot have produced
 * a token, so a token on screen is somebody else's; a line at or above it either collapsed (the token
 * rules below engage) or stayed literal (the generic match verifies it first, and this module is
 * never even consulted). Being exactly at the bound is sound in both directions because the two
 * matchers divide the shapes between them.
 */
const MIN_COLLAPSIBLE_LINE = 1000;

/**
 * A sent line this long MUST have collapsed (1200 chars: observed collapsed). Lines in the
 * (1000, 1200) band may go either way — the threshold lives in there — so they are claimed by
 * whichever shape the screen shows rather than required to be tokens.
 */
const MUST_COLLAPSE_LINE = 1200;

/**
 * Shortest literal fragment worth checking against what we sent. A wrap or a chunk boundary can leave
 * a couple of stray characters beside the token; demanding those match in order would reject a good
 * draft on debris, and accepting them proves nothing either way.
 */
const MIN_FRAGMENT_CHARS = 4;

interface Scan {
  /** The N of every placeholder token on screen, in order. */
  counts: number[];
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

/** Code points, not UTF-16 units and not bytes: what the token's N counts (probed with "é"). */
function charLength(s: string): number {
  return [...s].length;
}

/** Split a whitespace-stripped draft into its placeholder counts and the literal text around them. */
function scan(stripped: string): Scan {
  const re = new RegExp(PASTE_TOKEN.source, "g");
  const counts: number[] = [];
  const fragments: string[] = [];
  let cursor = 0;
  for (let m = re.exec(stripped); m !== null; m = re.exec(stripped)) {
    counts.push(Number(m[1]));
    if (m.index > cursor) fragments.push(stripped.slice(cursor, m.index));
    cursor = m.index + m[0].length;
  }
  let trailing: string | null = null;
  if (cursor < stripped.length) {
    trailing = stripped.slice(cursor);
    fragments.push(trailing);
  }
  return { counts, fragments, trailing };
}

/**
 * Whether the input box's visible `draft` is evidence that `sent` reached it, given that Muse
 * collapsed one or more of its lines into paste tokens. SUPPLEMENTAL: the reply guard consults this
 * only after its own literal-substring match has already failed, so a normal send is never routed
 * through this reasoning.
 *
 * Accepts only when every one of these holds:
 *  1. the draft carries at least one token, AND a collapse is plausible for OUR send — some line of
 *     it is long enough (MIN_COLLAPSIBLE_LINE) to have produced one. Without this gate a stale token
 *     from a previous paste would vouch for a short message that never landed, and the guard would
 *     press Enter into whatever has focus;
 *  2. every token's N is the length of a DISTINCT line of what we sent (multiset match — two tokens
 *     need two lines of those lengths). A token no sent line can account for is somebody else's;
 *  3. every sent line long enough to have NECESSARILY collapsed (MUST_COLLAPSE_LINE) has its token.
 *     Lines in the ambiguous band may go either way and are claimed by whichever shape the screen
 *     shows. Without this rule a dropped long line would pass silently;
 *  4. every literal fragment beside the tokens appears in what we sent, IN ORDER — the split
 *     token+tail shape, where the literal rows are the lines the heuristic left alone;
 *  5. when the draft ENDS in literal text, that trailing text is the END of what we sent, not merely
 *     somewhere inside it (the #110 rule). A partially arrived send passes 2–4 (its visible tail is
 *     still a prefix-ordered substring); the suffix is what distinguishes "the tail we can see is all
 *     the tail there is" from "later chunks are still missing".
 *
 * A draft that ends ON a token keeps rules 1–4 only: the end of our message is then inside a token,
 * where nothing is visible to compare. Same deliberate residual hole as Claude's (never observed —
 * truncation shows up as a literal dribble, not as a collapse).
 *
 * Anything inconsistent returns false and the caller keeps today's behaviour: no submit key, draft
 * kept, "didn't reach the input box". Guessing here would fire Enter at a screen we cannot read.
 */
export function musePasteCarriesSend(sent: string, draft: string): boolean {
  const d = stripWhitespace(draft);
  const s = stripWhitespace(sent);
  const { counts, fragments, trailing } = scan(d);
  if (counts.length === 0) return false;

  const lineLengths = sent.split("\n").map(charLength);
  if (!lineLengths.some((len) => len >= MIN_COLLAPSIBLE_LINE)) return false;

  // Rule 2: multiset match — each token consumes one distinct sent line of exactly its length.
  const remaining = [...lineLengths];
  for (const n of counts) {
    const i = remaining.indexOf(n);
    if (i < 0) return false;
    remaining.splice(i, 1);
  }

  // Rule 3: every necessarily-collapsed line must have been claimed by a token above.
  if (remaining.some((len) => len >= MUST_COLLAPSE_LINE)) return false;

  // Rule 5 (#110): a literal tail must be the END of the message.
  if (trailing !== null && !s.endsWith(trailing)) return false;

  // Rule 4: chained indexOf — each fragment occurs after the previous one, so a draft that shuffles
  // our words around (a different message sharing vocabulary) is rejected.
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
 * Whether the draft on the "❯" line carries any of Muse's own paste tokens. The stranded-draft
 * preview asks this before offering "Take over": copying a token into the phone composer as literal
 * text would send the token STRING at the agent while the real content stays behind in the terminal
 * box. The preview still SHOWS the draft honestly; only the take-over affordance stands down.
 *
 * ANY token stands it down, not just a token-only draft: a mixed token+tail take-over would still
 * lose the collapsed lines. The pre-clear sweep is unaffected (it clears by position, not content),
 * so standing down costs no send.
 */
export function museDraftIsOpaque(draft: string): boolean {
  return scan(stripWhitespace(draft)).counts.length > 0;
}
