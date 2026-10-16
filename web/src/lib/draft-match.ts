// Whether the input box's visible draft is the text the composer just sent: a DISPLAY read since M56
// spec 06. The send itself is decided on the bridge (the Send Protocol reads the screen at S1 and S2);
// the phone only uses this kind of match to tell its own reply, still echoing on the input line, from
// a stranded draft (hooks/use-terminal-draft.ts, `isSelfEcho`), and the harness tests use it to pin
// that each adapter reads a sent text back off the box. Moved here from lib/reply-action.ts, whose
// type-then-verify was the other caller and is gone.

import { graphemeSegmenter } from "./env";

/** Minimum visible characters that must match before we believe the input box holds OUR text. */
export const MIN_MATCH_CHARS = 8;

const REGEXP_META = /[.*+?^${}()|[\]\\]/g;

/**
 * The bridge's secret mask (`bridge/redact.ts`, `COLLIE_REDACT`, default on): a known secret shape on
 * screen reaches the phone as one `•` per hidden character. The operator's own send is never masked,
 * so a reply that carries a key reads back from the box as that key's mask. A mask character in the
 * draft therefore stands for exactly ONE printable ASCII character of `sent` (every pattern the bridge
 * masks is printable ASCII), or for a literal `•` the operator typed. Length and position still have
 * to agree, so a draft that dropped or altered a visible character still fails.
 */
const REDACT_MASK = "•";
const REDACT_SLOT = "(?:•|[\\x21-\\x7e])";

/** The exact gap extractInputDraft's fold inserts at a wrap seam: one plain space, always. Any
 *  other gap on screen is whitespace the operator really typed, so `sent` must carry it too. */
const FOLD_SEAM = " ";

/** `Intl.Segmenter` is the newest platform API anything in this bundle depends on (Firefox 125,
 *  Safari 14.1). A module-scope `new Intl.Segmenter` on an engine without it throws at evaluation,
 *  and in a module the app imports that white-screens the whole PWA at boot. Feature-detect instead: an unsupported engine must lose grapheme
 *  precision, never the app. The `null` branches below fall back to per-code-point counting, which
 *  is exactly what this check did before clusters were understood at all, a match that stops mid
 *  cluster slips through there, as it always did. */
const GRAPHEMES = graphemeSegmenter();

/** A cluster nobody can see: whitespace, or formatting controls that render as nothing at all
 *  (LRM/RLM, zero-width space, soft hyphen). A cluster that merely CONTAINS one still counts, the
 *  ZWJ inside a family emoji is joining visible characters, not standing in for them. */
const UNREADABLE = /^[\s\p{Default_Ignorable_Code_Point}]+$/u;

/** Visible characters. The floor below is a claim about how much of the message is legible on
 *  screen, so it must count what a reader counts, one emoji is one character, not the 11 UTF-16
 *  code units a ZWJ family sequence happens to occupy, and an invisible control is not a character
 *  at all however many of them are threaded through the text.
 *
 *  Segmenting the string AS GIVEN matters: stripping its spaces first can fuse the neighbours into
 *  one cluster. "🇯 🇵" is two characters, but strip the space and the regional indicators pair into
 *  the single flag "🇯🇵", one character, and a floor half as high as it should be. */
function visibleLength(s: string): number {
  let n = 0;
  if (GRAPHEMES === null) {
    // Code points, not code units, a lone surrogate half is never a character on any engine.
    for (const ch of s) if (!UNREADABLE.test(ch)) n += 1;
    return n;
  }
  for (const segment of GRAPHEMES.segment(s)) if (!UNREADABLE.test(segment.segment)) n += 1;
  return n;
}

/** Every offset in `s` where one visible character ends and the next begins, plus both ends. A match
 *  that starts or stops anywhere else has sliced a character in half, "👩‍👧‍👦" is a code-unit
 *  substring of "👨‍👩‍👧‍👦", but it is a DIFFERENT character and must not verify as that one. */
function characterBoundaries(s: string): Set<number> {
  const bounds = new Set<number>([s.length]);
  if (GRAPHEMES === null) {
    let i = 0;
    for (const ch of s) {
      bounds.add(i);
      i += ch.length;
    }
    return bounds;
  }
  for (const segment of GRAPHEMES.segment(s)) bounds.add(segment.index);
  return bounds;
}

/**
 * Whether the input box's visible draft is evidence that `sent` landed there. The box WINDOWS a long
 * draft (only its tail is on screen) and FOLDS its wrapped lines together with a space, so exact
 * equality is too strict, the strongest claim that survives both is that the draft's visible
 * characters appear contiguously in what we typed.
 *
 * The fold is the subtle part. extractInputDraft joins the box's visual lines with a space, which
 * restores a REAL space only when the box happened to wrap at a word boundary; wrapping mid-run (CJK
 * has no spaces to break at) fabricates a space the sent text never had. The joined string cannot
 * say which kind each of its spaces is, and one string can hold both, "これは pull request です"
 * wrapped mid-CJK has a genuine space AND a fabricated one. So the ambiguity is per-SEAM, not
 * per-string, and no language test can resolve it.
 *
 * Hence: split the draft on whitespace and require its non-space runs to appear in `sent` in order,
 * with only whitespace between them. Every visible character still has to be there, contiguously and
 * in order, only the WIDTH of a gap the fold could have produced is treated as unknowable, which is
 * exactly what the fold destroyed. A draft that dropped or altered a non-space character still fails.
 *
 * Only a gap spelled exactly like the fold's own seam (one plain space) may collapse to nothing, and
 * only that gap is loosened at all. Any other gap, a run of spaces, a tab, an ideographic space,
 * is whitespace the terminal actually rendered, so `sent` must carry that same whitespace verbatim.
 * Without the distinction the guard would accept a screen holding "危険　実行" for a send of
 * "危険実行", or "delete　file" for "delete file": different messages, both authorised.
 *
 * The match must also land on visible-character boundaries, because a code-unit substring can cut a
 * character in half, "👩‍👧‍👦" sits inside "👨‍👩‍👧‍👦" without being it.
 *
 * The length floor stops a short unrelated remnant ("y", "n", a placeholder) from passing as a
 * match; for a send shorter than the floor, the whole thing must be there. It counts non-space
 * characters, since spaces are the part we just agreed not to trust.
 */
export function draftCarriesSend(sent: string, draft: string | null): boolean {
  if (draft === null) return false;
  // Odd indices are the gaps, even indices the runs, the gaps decide how strict each seam is.
  const parts = draft.trim().split(/(\s+)/);
  const runs = parts.filter((_part, i) => i % 2 === 0);
  const gaps = parts.filter((_part, i) => i % 2 === 1);
  if (runs.length === 0 || runs[0]!.length === 0) return false;

  const visible = runs.reduce((n, run) => n + visibleLength(run), 0);
  if (visible < Math.min(visibleLength(sent), MIN_MATCH_CHARS)) return false;

  // Runs are whitespace-free by construction, so the joined pattern can never nest quantifiers.
  const escape = (s: string) => s.replace(REGEXP_META, "\\$&").replaceAll(REDACT_MASK, REDACT_SLOT);
  let pattern = escape(runs[0]!);
  for (let i = 1; i < runs.length; i++) {
    const gap = gaps[i - 1]!;
    pattern += (gap === FOLD_SEAM ? "\\s*" : escape(gap)) + escape(runs[i]!);
  }

  // Every occurrence gets its own boundary check, not just the first: an earlier hit that happens to
  // stop mid-character must not mask a later, properly aligned one. Rewinding to one past the hit's
  // start (rather than to its end) keeps overlapping occurrences reachable.
  const scan = new RegExp(pattern, "g");
  const bounds = characterBoundaries(sent);
  for (let hit = scan.exec(sent); hit !== null; hit = scan.exec(sent)) {
    if (bounds.has(hit.index) && bounds.has(hit.index + hit[0].length)) return true;
    scan.lastIndex = hit.index + 1;
  }
  return false;
}
