// The canonical styled projection is shared with the phone, which builds the value this verifies.
// It is pure and sits under web/src/lib beside the one SGR parser it is built on; the bridge imports
// it by relative path, as scripts/harness-canary/ does for web/src/lib/json.
import { decodeStyledRegion, STYLED_FORMAT, styledRegionLines } from "../web/src/lib/styled-region.ts";

/**
 * Normalize a rendered prompt region for comparison across terminal redraws.
 *
 * A terminal redraw can append trailing padding or change blank-line layout without changing the
 * question, so trailing whitespace and blank lines are ignored. Leading indentation and internal
 * alignment must survive because they can be semantic content in a displayed diff or command.
 */
// The two control characters are spliced in from their code points rather than written as escapes
// in the literal: matching them IS the point here, and a regex literal that says so is (correctly)
// flagged as suspicious wherever it isn't. `\x1b[` is the 7-bit CSI, `\x9b` its 8-bit form.
const CSI = `(?:${String.fromCodePoint(0x1b)}\\[|${String.fromCodePoint(0x9b)})`;
const SGR_SEQUENCE = new RegExp(`${CSI}[0-?]*[ -/]*m`, "g");

export function normalizePromptRegion(text: string): string[] {
  return text
    .replace(SGR_SEQUENCE, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length > 0);
}

// Across all 20 committed fixture regions, at most one normalized line follows a match. Six lines
// leave generous headroom for a status or spinner update while ensuring a replacement prompt, whose
// regions span 20 to 32 normalized lines, pushes a stale match outside the accepted tail.
export const DEFAULT_PROMPT_TAIL_LINES = 6;

export type PromptBindingResult =
  | { ok: true }
  | { ok: false; reason: "empty" | "not_found" | "not_in_tail" };

/** The reasons the style check refuses with. Spelled apart from the text check's so an audit line
 *  says which of the two refused. */
export type StyledRefusal = "style_empty" | "style_not_found" | "style_misaligned";

/** What the style check did on an accepted binding: `checked`, or `skipped_unknown_version` when the
 *  phone's value names a format this bridge does not know (the text check alone then decided). */
export type StyledOutcome = "checked" | "skipped_unknown_version";

/** The one verdict of {@link verifyPromptBinding}. `styled` is present exactly when the caller gave a
 *  styled value. */
export type PromptBindingVerdict =
  | { ok: true; styled?: StyledOutcome }
  | { ok: false; reason: Extract<PromptBindingResult, { ok: false }>["reason"] | StyledRefusal };

/** The verdict of {@link verifyExpectedStyled}: the strict form for a caller that needs the style
 *  actually checked, so an unknown format version is a refusal here (`style_unchecked`). */
export type StyledBindingResult =
  | { ok: true }
  | { ok: false; reason: Extract<PromptBindingVerdict, { ok: false }>["reason"] | "style_unchecked" };

/**
 * Find `expected` as a contiguous run of `fresh` lines, the LAST such run, and require it to end
 * inside the last `tailLines` lines. Returns where the run starts, so the style check can look at the
 * same place.
 */
function matchInTail(
  fresh: string[],
  expected: string[],
  tailLines: number,
): { ok: true; start: number } | { ok: false; reason: "not_found" | "not_in_tail" } {
  let lastMatch = -1;
  candidate: for (let start = 0; start <= fresh.length - expected.length; start++) {
    for (let offset = 0; offset < expected.length; offset++) {
      if (fresh[start + offset] !== expected[offset]) continue candidate;
    }
    lastMatch = start;
  }
  if (lastMatch === -1) return { ok: false, reason: "not_found" };

  const boundedTailLines = Math.max(0, Math.floor(tailLines));
  const tailStart = Math.max(0, fresh.length - boundedTailLines);
  const matchEnd = lastMatch + expected.length - 1;
  if (matchEnd < tailStart) return { ok: false, reason: "not_in_tail" };
  return { ok: true, start: lastMatch };
}

type TextRefusal = Extract<PromptBindingResult, { ok: false }>["reason"];

/** The text check on already normalized lines: where the expected region starts, or why not. */
function matchText(
  freshLines: string[],
  expected: string,
  tailLines: number,
): { ok: true; start: number } | { ok: false; reason: TextRefusal } {
  const expectedLines = normalizePromptRegion(expected);
  if (expectedLines.length === 0) return { ok: false, reason: "empty" };
  return matchInTail(freshLines, expectedLines, tailLines);
}

export function verifyExpectedPrompt(
  freshText: string,
  expected: string,
  tailLines = DEFAULT_PROMPT_TAIL_LINES,
): PromptBindingResult {
  const match = matchText(normalizePromptRegion(freshText), expected, tailLines);
  return match.ok ? { ok: true } : { ok: false, reason: match.reason };
}

/**
 * The whole binding verdict for one read: the text check, then, when the phone sent a styled value,
 * the style check AT THE SAME PLACE (ADR 0080 point 7).
 *
 * The text check is `verifyExpectedPrompt`'s: the last contiguous match of the normalized expected
 * lines, ending inside the last `tailLines`. The style check does not search. The two projections
 * drop the same lines (a line with no visible text is dropped by both), so the normalized text lines
 * and the canonical styled lines of one read have the same count and aligned indices. The expected
 * styled lines must therefore equal the fresh styled lines exactly at the index where the text
 * matched. A search of its own could match a stale copy of the region higher up in the buffer, in a
 * pointer state the screen no longer shows, while the text matched the live copy below.
 *
 *   - `style_misaligned`: the fresh read's two projections differ in length, so no index means the
 *     same line in both. Refused, never guessed at.
 *   - `style_not_found`: the styled lines at the text's index differ from the expected ones, or the
 *     expected ones are not as many as the expected text lines.
 *   - `style_empty`: the styled value holds no lines.
 *   - a value whose first line is not the format this bridge knows (`STYLED_FORMAT`) is neither an
 *     error nor a refusal: the style check is skipped and the verdict says so. A newer phone must not
 *     have every tap of an older bridge refused.
 */
export function verifyPromptBinding(
  freshText: string,
  expected: string,
  expectedStyled?: string,
  tailLines = DEFAULT_PROMPT_TAIL_LINES,
): PromptBindingVerdict {
  const freshLines = normalizePromptRegion(freshText);
  const match = matchText(freshLines, expected, tailLines);
  if (!match.ok) return { ok: false, reason: match.reason };
  if (expectedStyled === undefined) return { ok: true };

  const decoded = decodeStyledRegion(expectedStyled);
  if (decoded === null || (decoded.version === STYLED_FORMAT && decoded.lines.length === 0)) {
    return { ok: false, reason: "style_empty" };
  }
  if (decoded.version !== STYLED_FORMAT) return { ok: true, styled: "skipped_unknown_version" };

  const freshStyled = styledRegionLines(freshText);
  if (freshStyled.length !== freshLines.length) return { ok: false, reason: "style_misaligned" };
  const expectedLineCount = normalizePromptRegion(expected).length;
  if (decoded.lines.length !== expectedLineCount) return { ok: false, reason: "style_not_found" };
  for (let offset = 0; offset < decoded.lines.length; offset++) {
    if (freshStyled[match.start + offset] !== decoded.lines[offset]) {
      return { ok: false, reason: "style_not_found" };
    }
  }
  return { ok: true, styled: "checked" };
}

/**
 * The style check as a pass/fail for a caller that must know the style WAS checked (the conformance
 * suite): {@link verifyPromptBinding} on the model's text and its styled value, with an unknown
 * format version reported as `style_unchecked` instead of an acceptance.
 */
export function verifyExpectedStyled(
  freshText: string,
  expected: string,
  expectedStyled: string,
  tailLines = DEFAULT_PROMPT_TAIL_LINES,
): StyledBindingResult {
  const verdict = verifyPromptBinding(freshText, expected, expectedStyled, tailLines);
  if (!verdict.ok) return verdict;
  if (verdict.styled !== "checked") return { ok: false, reason: "style_unchecked" };
  return { ok: true };
}
