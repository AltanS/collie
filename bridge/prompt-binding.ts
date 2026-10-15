// The canonical styled projection is shared with the phone, which builds the value this verifies.
// It is pure and sits under web/src/lib beside the one SGR parser it is built on; the bridge imports
// it by relative path, as scripts/harness-canary/ does for web/src/lib/json.
import { decodeStyledRegion, STYLED_FORMAT, styledRegionLines } from "../web/src/lib/styled-region.ts";
// The column range of a bound region (`expected_columns`) is cut by one function shared the same way.
import { cropRawColumns, type ColumnRange } from "../web/src/lib/column-range.ts";
// The task checklist Claude Code 2.1.299 draws under a dialog is recognised by the one function the
// phone uses to take it off before its grammars run.
import { trailingTaskChecklistStart } from "../web/src/lib/task-checklist.ts";

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
// regions span 20 to 32 normalized lines, pushes a stale match outside the accepted tail. A task
// checklist at the very end of the read (Claude Code 2.1.299 draws it under a dialog's footer) is not
// counted: it ran to seven rows in the 2.1.299 captures (the header, five tasks and the `… +N`
// overflow row Claude folds the rest into) and would push every live region out. Only a list whose counts
// agree with its header is skipped (`trailingTaskChecklistStart`), so output that merely looks like
// one still counts, and the window cannot be widened by it.
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
 * same place. The caller has already cut a trailing task checklist off `fresh` (see `matchText`).
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

/** The text check on already normalized lines: where the expected region starts, or why not. A task
 *  checklist that ends the read is not counted against the tail (`DEFAULT_PROMPT_TAIL_LINES`). Only
 *  the end is cut, so the start returned still indexes `freshLines`. */
function matchText(
  freshLines: string[],
  expected: string,
  tailLines: number,
): { ok: true; start: number } | { ok: false; reason: TextRefusal } {
  const expectedLines = normalizePromptRegion(expected);
  if (expectedLines.length === 0) return { ok: false, reason: "empty" };
  const end = trailingTaskChecklistStart(freshLines) ?? freshLines.length;
  return matchInTail(freshLines.slice(0, end), expectedLines, tailLines);
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
 * When the phone named a column range (`expected_columns`, `PromptModel.bindColumns`), every row of
 * the fresh read is first cut to those columns (`cropRawColumns`), and both checks then run on the
 * cut read exactly as below. So a change outside the range, such as Oh My Pi's side panel ticking
 * beside a question, does not refuse the tap, and a change inside it does. The cut is applied to the
 * whole read, not only to the matched rows: the bridge does not know which rows match until it has
 * compared them. Rows the cut leaves empty drop out of both projections alike, so the tail bound
 * counts the rows that carry text inside the range. Without a range the read is compared whole.
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
  readText: string,
  expected: string,
  expectedStyled?: string,
  columns?: ColumnRange,
  tailLines = DEFAULT_PROMPT_TAIL_LINES,
): PromptBindingVerdict {
  const freshText = columns === undefined ? readText : cropRawColumns(readText, columns);
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
  const verdict = verifyPromptBinding(freshText, expected, expectedStyled, undefined, tailLines);
  if (!verdict.ok) return verdict;
  if (verdict.styled !== "checked") return { ok: false, reason: "style_unchecked" };
  return { ok: true };
}
